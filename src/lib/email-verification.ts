import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { getBillingSettings } from "./billing-settings";

type EmailVerificationRow = {
	id: number;
	email: string;
	email_normalized: string;
	code_hash: string;
	status: "pending" | "verified" | "expired" | "superseded" | "used";
	verify_attempts: number;
	expires_at: string;
	cooldown_until: string;
};

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_EMAIL_FROM = "Merlin <onboarding@resend.dev>";
const CODE_TTL_SECONDS = 10 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_WINDOW = 10;
const SEND_WINDOW_SECONDS = 10 * 60;
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFIED_REUSE_SECONDS = 30 * 60;

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

function addSeconds(date: Date, seconds: number) {
	return new Date(date.getTime() + seconds * 1000).toISOString();
}

function generateVerificationCode() {
	const values = new Uint32Array(1);
	crypto.getRandomValues(values);
	return String((values[0] ?? 0) % 1_000_000).padStart(6, "0");
}

async function hmacSha256Hex(secret: string, message: string) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashVerificationCode(c: AppContext, emailNormalized: string, code: string) {
	const secret = String(c.env.SESSION_HASH_SECRET || "").trim();
	if (!secret) {
		throw new HTTPException(500, { message: "SESSION_HASH_SECRET is not configured" });
	}
	return hmacSha256Hex(secret, `${emailNormalized}:${code}`);
}

function getEmailFrom(c: AppContext) {
	return String(c.env.EMAIL_FROM || DEFAULT_EMAIL_FROM).trim() || DEFAULT_EMAIL_FROM;
}

function renderVerificationEmail(code: string) {
	return {
		subject: `Código Merlin: ${code}`,
		text: [
			`Código Merlin: ${code}`,
			"",
			"Use este código para confirmar seu e-mail e continuar o cadastro.",
			"",
			"Esse código expira em 10 minutos.",
			"Se você não solicitou esse acesso, ignore este e-mail.",
		].join("\n"),
		html: `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="color-scheme" content="light dark">
		<meta name="supported-color-schemes" content="light dark">
		<style>
			:root { color-scheme: light dark; supported-color-schemes: light dark; }
		</style>
	</head>
	<body style="margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
		<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Código Merlin: ${code}</div>
		<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0;padding:0;border-collapse:collapse;">
			<tr>
				<td align="center" style="padding:32px 16px;">
					<table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:520px;border:1px solid #a855f7;border-radius:18px;border-collapse:separate;">
						<tr>
							<td style="padding:28px;font-family:Arial,Helvetica,sans-serif;">
								<p style="margin:0 0 8px;color:#a855f7;font-size:13px;line-height:18px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">MERLIN</p>
								<h1 style="margin:0 0 12px;font-size:24px;line-height:30px;font-weight:700;">Código de acesso</h1>
								<p style="margin:0 0 22px;font-size:14px;line-height:22px;">Use o código abaixo para confirmar seu e-mail e continuar o cadastro.</p>
								<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #a855f7;border-radius:14px;border-collapse:separate;">
									<tr>
										<td align="center" style="padding:18px 16px;font-family:Arial,Helvetica,sans-serif;font-size:34px;line-height:40px;font-weight:700;letter-spacing:8px;">${code}</td>
									</tr>
								</table>
								<p style="margin:22px 0 0;font-size:14px;line-height:22px;">Esse código expira em 10 minutos. Se você não solicitou esse acesso, ignore este e-mail.</p>
							</td>
						</tr>
					</table>
				</td>
			</tr>
		</table>
	</body>
</html>`,
	};
}

async function sendVerificationEmail(c: AppContext, input: { email: string; code: string; idempotencyKey: string }) {
	const apiKey = String(c.env.RESEND_API_KEY || "").trim();
	if (!apiKey) {
		throw new HTTPException(500, { message: "RESEND_API_KEY is not configured" });
	}

	const message = renderVerificationEmail(input.code);
	const from = getEmailFrom(c);
	const response = await fetch(RESEND_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"Idempotency-Key": input.idempotencyKey,
			"User-Agent": "Merlin API",
		},
		body: JSON.stringify({
			from,
			to: [input.email],
			subject: message.subject,
			html: message.html,
			text: message.text,
		}),
	});

	if (response.ok) {
		return;
	}

	let detail = "";
	try {
		detail = await response.text();
	} catch {
		detail = "";
	}
	console.warn("[email-verification] resend failed", response.status, detail.slice(0, 300));
	throw new HTTPException(502, { message: "Could not send verification email" });
}

async function getLatestPendingVerification(c: AppContext, emailNormalized: string) {
	return c.env.merlin_db
		.prepare(
			`
				SELECT id, email, email_normalized, code_hash, status, verify_attempts, expires_at, cooldown_until
				FROM email_verifications
				WHERE email_normalized = ?
					AND status = 'pending'
				ORDER BY id DESC
				LIMIT 1
			`,
		)
		.bind(emailNormalized)
		.first<EmailVerificationRow>();
}

async function countRecentSends(c: AppContext, emailNormalized: string, sinceIso: string) {
	const row = await c.env.merlin_db
		.prepare(
			`
				SELECT COUNT(*) AS total
				FROM email_verifications
				WHERE email_normalized = ?
					AND created_at >= ?
			`,
		)
		.bind(emailNormalized, sinceIso)
		.first<{ total: number }>();

	return row?.total || 0;
}

export async function startPublicEmailVerification(c: AppContext, email: string) {
	const normalizedEmail = normalizeEmail(email);
	const now = new Date();
	const nowIso = now.toISOString();
	const latest = await getLatestPendingVerification(c, normalizedEmail);

	if (latest && latest.cooldown_until > nowIso) {
		throw new HTTPException(429, { message: "Aguarde 1 minuto antes de solicitar um novo código." });
	}

	const recentSends = await countRecentSends(c, normalizedEmail, addSeconds(now, -SEND_WINDOW_SECONDS));
	if (recentSends >= MAX_SENDS_PER_WINDOW) {
		throw new HTTPException(429, { message: "O limite temporário de envios foi atingido. Tente novamente em alguns minutos." });
	}

	const code = generateVerificationCode();
	const codeHash = await hashVerificationCode(c, normalizedEmail, code);
	const expiresAt = addSeconds(now, CODE_TTL_SECONDS);
	const cooldownUntil = addSeconds(now, RESEND_COOLDOWN_SECONDS);
	const idempotencyKey = `public-email-${normalizedEmail}-${now.getTime()}`;
	const isStaging = c.env.ENVIRONMENT === "staging";
	const billing = isStaging ? await getBillingSettings(c) : null;
	const useStagingTestCode = isStaging && !billing?.stagingEmailDeliveryEnabled;

	if (!useStagingTestCode) {
		await sendVerificationEmail(c, { email, code, idempotencyKey });
	}

	await c.env.merlin_db
		.prepare(
			`
				UPDATE email_verifications
				SET status = 'superseded', updated_at = ?
				WHERE email_normalized = ?
					AND status = 'pending'
			`,
		)
		.bind(nowIso, normalizedEmail)
		.run();

	await c.env.merlin_db
		.prepare(
			`
				INSERT INTO email_verifications (
					email, email_normalized, code_hash, status, provider, verify_attempts, expires_at, cooldown_until, last_sent_at, created_at, updated_at
				)
				VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)
			`,
		)
		.bind(email.trim(), normalizedEmail, codeHash, useStagingTestCode ? "staging_test" : "resend", expiresAt, cooldownUntil, nowIso, nowIso, nowIso)
		.run();

	return {
		success: true as const,
		cooldownSeconds: RESEND_COOLDOWN_SECONDS,
		expiresIn: CODE_TTL_SECONDS,
		deliveryMode: useStagingTestCode ? ("staging_test" as const) : ("email" as const),
	};
}

export async function verifyPublicEmailCode(c: AppContext, input: { email: string; code: string }) {
	const normalizedEmail = normalizeEmail(input.email);
	const nowIso = new Date().toISOString();
	const row = await getLatestPendingVerification(c, normalizedEmail);

	if (!row) {
		throw new HTTPException(400, { message: "Código de verificação inválido ou expirado." });
	}

	if (row.expires_at <= nowIso) {
		await c.env.merlin_db
			.prepare(`UPDATE email_verifications SET status = 'expired', updated_at = ? WHERE id = ?`)
			.bind(nowIso, row.id)
			.run();
		throw new HTTPException(400, { message: "Código de verificação expirado." });
	}

	if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS) {
		throw new HTTPException(429, { message: "O limite temporário de tentativas foi atingido. Solicite um novo código." });
	}

	const isStagingTestCode = c.env.ENVIRONMENT === "staging" && input.code.trim() === "12345";
	const expectedHash = await hashVerificationCode(c, normalizedEmail, input.code.trim());
	if (!isStagingTestCode && expectedHash !== row.code_hash) {
		await c.env.merlin_db
			.prepare(`UPDATE email_verifications SET verify_attempts = verify_attempts + 1, updated_at = ? WHERE id = ?`)
			.bind(nowIso, row.id)
			.run();
		throw new HTTPException(400, { message: "Código de verificação inválido." });
	}

	await c.env.merlin_db
		.prepare(`UPDATE email_verifications SET status = 'verified', verified_at = ?, updated_at = ? WHERE id = ?`)
		.bind(nowIso, nowIso, row.id)
		.run();

	return {
		success: true as const,
		verified: true as const,
	};
}

export async function assertRecentPublicEmailVerification(c: AppContext, email: string) {
	const normalizedEmail = normalizeEmail(email);
	const cutoffIso = addSeconds(new Date(), -VERIFIED_REUSE_SECONDS);
	const row = await c.env.merlin_db
		.prepare(
			`
				SELECT id
				FROM email_verifications
				WHERE email_normalized = ?
					AND status = 'verified'
					AND verified_at IS NOT NULL
					AND verified_at >= ?
					AND used_at IS NULL
				ORDER BY id DESC
				LIMIT 1
			`,
		)
		.bind(normalizedEmail, cutoffIso)
		.first<{ id: number }>();

	if (!row) {
		throw new HTTPException(403, { message: "Email verification is required" });
	}

	return row.id;
}

export async function consumePublicEmailVerification(c: AppContext, verificationId: number) {
	const nowIso = new Date().toISOString();
	await c.env.merlin_db
		.prepare(
			`
				UPDATE email_verifications
				SET status = 'used',
					used_at = ?,
					updated_at = ?
				WHERE id = ?
					AND status = 'verified'
					AND used_at IS NULL
			`,
		)
		.bind(nowIso, nowIso, verificationId)
		.run();
}
