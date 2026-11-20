import { HTTPException } from "hono/http-exception";
import { safeErrorText } from "./api-error-log";
import { verifyAccessToken } from "./auth";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import type { AppContext } from "../types";

export type LauncherLicense = {
	id: number;
	licenseKey: string;
	name: string;
	hwid: string;
	expiresAt: string;
	planTier: PlanTier;
};

type LicenseLookup = {
	id: number;
	license_key: string;
	name: string;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked" | "expired";
	plan_tier: string | null;
};

function transientLicenseLookupFailure(error: unknown) {
	const messages = error instanceof Error
		? [error.message, error.cause instanceof Error ? error.cause.message : ""].join("\n")
		: "";
	if (/queued for too long|D1 DB is overloaded/i.test(messages)) return "database_overloaded";
	if (/Network connection lost|Replica disconnected from primary/i.test(messages)) return "connection_lost";
	if (/storage caused object to be reset|reset because its code was updated/i.test(messages)) return "database_reset";
	if (/Cannot resolve D1 DB due to transient issue|D1_ERROR:\s*(?:internal error|service unavailable|temporarily unavailable)/i.test(messages)) {
		return "database_unavailable";
	}
	return null;
}

function licenseLookupDiagnostic(error: unknown) {
	if (!(error instanceof Error)) return undefined;
	// Keep the database error headline. Drop identifiers, URLs and credential-like strings.
	return safeErrorText(error.message.split(/\r?\n/, 1)[0] ?? "").slice(0, 240);
}

async function readCloudLauncherLicense(c: AppContext, lookup: () => Promise<LicenseLookup | null>) {
	let attempt = 1;
	for (;;) {
		try {
			return await lookup();
		} catch (error) {
			const reason = transientLicenseLookupFailure(error);
			const willRetry = Boolean(reason && reason !== "database_overloaded" && attempt === 1);
			console.warn("[cloud-sync:license-lookup-failed]", {
				reason: reason ?? "unclassified", attempt, willRetry,
				d1Message: licenseLookupDiagnostic(error),
				d1Cause: error instanceof Error ? licenseLookupDiagnostic(error.cause) : undefined,
			});
			if (!reason) throw error;
			if (willRetry) {
				attempt += 1;
				await new Promise(resolve => setTimeout(resolve, 350 + Math.random() * 250));
				continue;
			}
			c.header("Retry-After", "3");
			throw Object.assign(new HTTPException(503, { message: "Cloud save license verification is temporarily unavailable", cause: error }),
				{ code: "cloud_license_unavailable" });
		}
	}
}

export function parseBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;

	const [scheme, token] = header.split(" ");
	return scheme === "Bearer" && token ? token : null;
}

export async function requireLauncherLicense(c: AppContext, options?: { retryCloudLookup: boolean }): Promise<LauncherLicense> {
	const accessToken = parseBearerToken(c.req.raw);
	if (!accessToken) {
		throw new HTTPException(401, { message: "Missing access token" });
	}

	if (!c.env.JWT_SECRET) {
		throw new HTTPException(500, { message: "JWT secret is not configured" });
	}

	const payload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
	if (payload.exp <= Math.floor(Date.now() / 1000)) {
		throw new HTTPException(401, { message: "Access token expired" });
	}

	const lookup = () => c.env.merlin_db
		.prepare(
			`
				SELECT id, license_key, name, hwid, expires_at, status, plan_tier
				FROM licenses
				WHERE id = ?
				LIMIT 1
			`,
		)
		.bind(payload.sub)
		.first<LicenseLookup>();
	const license = options?.retryCloudLookup ? await readCloudLauncherLicense(c, lookup) : await lookup();

	if (!license) {
		throw new HTTPException(401, { message: "License not found" });
	}
	const expiresAt = new Date(license.expires_at);
	if (license.status === "expired" || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
		throw Object.assign(new HTTPException(401, { message: "License expired" }), { licenseId: license.id });
	}
	if (license.status !== "active") {
		throw new HTTPException(401, { message: "License is not active" });
	}
	if (!license.hwid || license.hwid !== payload.hwid) {
		throw new HTTPException(401, { message: "HWID mismatch" });
	}

	return {
		id: license.id,
		licenseKey: license.license_key,
		name: license.name,
		hwid: license.hwid,
		expiresAt: license.expires_at,
		planTier: normalizeStoredPlanTier(license.plan_tier, "ouro"),
	};
}

export async function requireGoldLauncherLicense(c: AppContext): Promise<LauncherLicense> {
	const license = await requireLauncherLicense(c);
	if (license.planTier !== "ouro") {
		throw new HTTPException(403, { message: "This feature requires a Gold plan" });
	}
	return license;
}

// Read-only launcher/account actions may identify an expired license, but every
// activation, manifest and download continues to use requireLauncherLicense.
export async function requireLauncherSearchLicense(c: AppContext): Promise<LauncherLicense> {
	const accessToken = parseBearerToken(c.req.raw);
	if (!accessToken) throw new HTTPException(401, { message: "Missing access token" });
	if (!c.env.JWT_SECRET) throw new HTTPException(500, { message: "JWT secret is not configured" });

	const payload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
	if (payload.exp <= Math.floor(Date.now() / 1000)) {
		throw new HTTPException(401, { message: "Access token expired" });
	}

	const license = await c.env.merlin_db
		.prepare("SELECT id, license_key, name, hwid, expires_at, status, plan_tier FROM licenses WHERE id = ? LIMIT 1")
		.bind(payload.sub)
		.first<LicenseLookup>();
	if (!license) throw new HTTPException(401, { message: "License not found" });
	if (license.status !== "active" && license.status !== "expired") {
		throw new HTTPException(401, { message: "License is not active" });
	}
	if (!license.hwid || license.hwid !== payload.hwid) {
		throw new HTTPException(401, { message: "HWID mismatch" });
	}

	return { id: license.id, licenseKey: license.license_key, name: license.name, hwid: license.hwid,
		expiresAt: license.expires_at, planTier: normalizeStoredPlanTier(license.plan_tier, "ouro") };
}
