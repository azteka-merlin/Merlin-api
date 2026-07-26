import type { AppContext } from "../types";

type AccessKeyEmailInput = {
	email: string;
	name?: string | null;
	licenseKey: string;
};

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_EMAIL_FROM = "Merlin <onboarding@resend.dev>";
const DOWNLOAD_URL = "https://api-merlin.com/download";

function getEmailFrom(c: AppContext) {
	return String(c.env.EMAIL_FROM || DEFAULT_EMAIL_FROM).trim() || DEFAULT_EMAIL_FROM;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function renderAccessKeyEmail(input: AccessKeyEmailInput & { mode: "welcome" | "recovery" }) {
	const name = input.name?.trim() || "usuário Merlin";
	const title = input.mode === "welcome" ? "Bem-vindo ao Merlin" : "Sua chave Merlin está aqui";
	const intro = input.mode === "welcome"
		? `Olá, ${name}. Sua chave de acesso foi criada com sucesso. Guarde-a em um lugar seguro para entrar no Merlin sempre que precisar.`
		: "Recebemos uma solicitação para recuperar sua chave de acesso. Use a chave abaixo para abrir o Merlin e continuar de onde parou.";
	const footer = input.mode === "welcome"
		? "Seu PIN de recuperação foi definido no cadastro. Por segurança, ele não é exibido neste e-mail."
		: "Se você não solicitou essa recuperação, entre em contato com o suporte Merlin para revisar o acesso da sua chave.";

	return {
		subject: input.mode === "welcome" ? "Bem-vindo ao Merlin" : "Sua chave Merlin está aqui",
		text: [
			title,
			"",
			intro,
			"",
			`Chave: ${input.licenseKey}`,
			"",
			footer,
			"",
			`Baixar Merlin: ${DOWNLOAD_URL}`,
		].join("\n"),
		html: `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="color-scheme" content="light dark">
		<meta name="supported-color-schemes" content="light dark">
	</head>
	<body style="margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;">
		<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0;padding:0;border-collapse:collapse;">
			<tr>
				<td align="center" style="padding:32px 16px;">
					<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border:1px solid #a855f7;border-radius:18px;border-collapse:separate;overflow:hidden;">
						<tr>
							<td style="padding:28px;font-family:Arial,Helvetica,sans-serif;">
								<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 22px;border:1px solid #a855f7;border-radius:14px;border-collapse:separate;overflow:hidden;">
									<tr>
										<td align="center" style="padding:30px 16px 26px;font-family:Arial,Helvetica,sans-serif;background:#15151d;">
											<div style="font-size:44px;line-height:48px;font-weight:900;letter-spacing:6px;color:#f8fafc;text-transform:uppercase;">MERLIN</div>
											<div style="width:84px;height:3px;margin:16px auto 0;background:#a855f7;line-height:3px;font-size:3px;">&nbsp;</div>
											<p style="margin:14px 0 0;color:#c4b5fd;font-size:14px;line-height:21px;font-weight:700;">Acesso configurado com segurança.</p>
										</td>
									</tr>
								</table>
								<p style="margin:0 0 8px;color:#a855f7;font-size:13px;line-height:18px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">MERLIN</p>
								<h1 style="margin:0 0 12px;font-size:24px;line-height:30px;font-weight:700;">${escapeHtml(title)}</h1>
								<p style="margin:0 0 22px;font-size:14px;line-height:22px;">${escapeHtml(intro)}</p>
								<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #a855f7;border-radius:14px;border-collapse:separate;">
									<tr>
										<td align="center" style="padding:18px 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:30px;font-weight:700;letter-spacing:1px;">${escapeHtml(input.licenseKey)}</td>
									</tr>
								</table>
								<p style="margin:22px 0 0;font-size:14px;line-height:22px;">${escapeHtml(footer)}</p>
								<p style="margin:22px 0 0;">
									<a href="${DOWNLOAD_URL}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#7c3aed;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Baixar Merlin</a>
								</p>
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

async function sendAccessKeyEmail(c: AppContext, input: AccessKeyEmailInput & { mode: "welcome" | "recovery" }) {
	const apiKey = String(c.env.RESEND_API_KEY || "").trim();
	if (!apiKey) {
		throw new Error("RESEND_API_KEY is not configured");
	}

	const message = renderAccessKeyEmail(input);
	const response = await fetch(RESEND_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"Idempotency-Key": `access-key-${input.mode}-${input.email}-${input.licenseKey}`,
			"User-Agent": "Merlin API",
		},
		body: JSON.stringify({
			from: getEmailFrom(c),
			to: [input.email],
			subject: message.subject,
			html: message.html,
			text: message.text,
		}),
	});

	if (response.ok) {
		return response.json().catch(() => ({ success: true }));
	}

	const detail = await response.text().catch(() => "");
	throw new Error(`Access key email failed with ${response.status}: ${detail.slice(0, 300)}`);
}

export async function sendWelcomeAccessKeyEmail(c: AppContext, input: AccessKeyEmailInput) {
	return sendAccessKeyEmail(c, { ...input, mode: "welcome" });
}

export async function sendRecoveredAccessKeyEmail(c: AppContext, input: AccessKeyEmailInput) {
	return sendAccessKeyEmail(c, { ...input, mode: "recovery" });
}
