import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type LicenseStatusValue = "active" | "revoked" | "expired";

export type LicenseRecord = {
	id: number;
	license_key: string;
	name: string;
	contact: string;
	contact_type: "phone" | "email" | "discord" | "none";
	source: "admin" | "public_signup" | "purchase" | "gift" | "manual_import" | "stripe" | "mercadopago_pix";
	license_type?: "normal" | "test" | null;
	plan_tier?: "bronze" | "prata" | "ouro" | null;
	premium_catalog_restricted?: number | null;
	normal_activation_limit?: number | null;
	premium_activation_limit?: number | null;
	normal_activation_used?: number | null;
	premium_activation_used?: number | null;
	activation_usage_reset_at?: string | null;
	recovery_pin_hash: string | null;
	recovery_notice_accepted_at: string | null;
	hwid: string | null;
	expires_at: string;
	status: LicenseStatusValue;
	revoked_reason: string | null;
	revoked_origin?: string | null;
	revoked_event_id?: string | null;
	customer_id?: number | null;
	access_type?: string | null;
	billing_status?: string | null;
	stripe_customer_id?: string | null;
	stripe_subscription_id?: string | null;
	stripe_checkout_session_id?: string | null;
	billing_current_period_end?: string | null;
	billing_current_period_start?: string | null;
	billing_cancel_at_period_end?: number | null;
	created_at: string;
	updated_at: string;
};

export function generateLicenseChunk(): string {
	let chunk = "";

	for (let index = 0; index < 4; index += 1) {
		const randomValue = crypto.getRandomValues(new Uint32Array(1))[0];
		if (randomValue === undefined) {
			throw new Error("Unable to generate license key");
		}
		const randomIndex = randomValue % LICENSE_ALPHABET.length;
		chunk += LICENSE_ALPHABET[randomIndex];
	}

	return chunk;
}

export function generateLicenseKey(): string {
	return `MERLIN-${generateLicenseChunk()}-${generateLicenseChunk()}-${generateLicenseChunk()}`;
}

export function requireAdminToken(c: AppContext): string {
	const header = c.req.raw.headers.get("authorization");

	if (!header || !c.env.ADMIN_API_TOKEN) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	const [scheme, token] = header.split(" ");

	if (scheme !== "Bearer" || token !== c.env.ADMIN_API_TOKEN) {
		throw new HTTPException(401, { message: "Unauthorized" });
	}

	return "admin:primary";
}

export function toIsoDateStart(date: string): string {
	return new Date(`${date}T00:00:00.000Z`).toISOString();
}

// Admin-entered dates represent a full calendar day in the Brazilian admin timezone.
export function toIsoDateEndBrt(date: string): string {
	return new Date(`${date}T23:59:59.999-03:00`).toISOString();
}

export function toDateOnly(value: string): string {
	return value.slice(0, 10);
}

export function isLicenseDateExpired(expiresAt: string, now = new Date()): boolean {
	const date = new Date(expiresAt);
	return Number.isFinite(date.getTime()) && date.getTime() < now.getTime();
}

export function resolveLicenseStatus(record: Pick<LicenseRecord, "status" | "expires_at">): LicenseStatusValue {
	if (record.status === "revoked") {
		return "revoked";
	}
	if (isLicenseDateExpired(record.expires_at)) {
		return "expired";
	}
	return "active";
}

export function mapLicenseResponse(record: LicenseRecord) {
	return {
		id: record.id,
		licenseKey: record.license_key,
		name: record.name,
		contact: record.contact,
		contactType: record.contact_type,
		source: record.source,
		licenseType: record.license_type || "normal",
		planTier: record.license_type === "test" ? null : record.plan_tier || "ouro",
		premiumCatalogRestricted: record.premium_catalog_restricted === 1,
		normalActivationLimit: record.normal_activation_limit ?? null,
		premiumActivationLimit: record.premium_activation_limit ?? null,
		normalActivationUsed: record.normal_activation_used ?? 0,
		premiumActivationUsed: record.premium_activation_used ?? 0,
		activationUsageResetAt: record.activation_usage_reset_at || null,
		hasRecoveryPin: Boolean(record.recovery_pin_hash),
		recoveryNoticeAcceptedAt: record.recovery_notice_accepted_at,
		phone: record.contact,
		hwid: record.hwid,
		expiresAt: toDateOnly(record.expires_at),
		status: resolveLicenseStatus(record),
		revokedReason: record.revoked_reason,
		revokedOrigin: record.revoked_origin || null,
		revokedEventId: record.revoked_event_id || null,
		customerId: record.customer_id ?? null,
		accessType: record.access_type || "free",
		billingStatus: record.billing_status || "none",
		stripeCustomerId: record.stripe_customer_id || null,
		stripeSubscriptionId: record.stripe_subscription_id || null,
		stripeCheckoutSessionId: record.stripe_checkout_session_id || null,
		billingCurrentPeriodEnd: record.billing_current_period_end || null,
		billingCurrentPeriodStart: record.billing_current_period_start || null,
		billingCancelAtPeriodEnd: Boolean(record.billing_cancel_at_period_end),
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	};
}

export async function getLicenseById(c: AppContext, id: number): Promise<LicenseRecord> {
	const license = await c.env.merlin_db
		.prepare(
			`
				SELECT
					id,
					license_key,
					name,
					contact,
					contact_type,
					source,
					COALESCE(license_type, 'normal') AS license_type,
					plan_tier,
					COALESCE(premium_catalog_restricted, 0) AS premium_catalog_restricted,
					normal_activation_limit,
					premium_activation_limit,
					activation_usage_reset_at,
					(
						SELECT COUNT(DISTINCT ual.app_id)
						FROM user_activity_logs ual
						WHERE ual.license_id = licenses.id
							AND ual.action = 'game_activation_success'
							AND ual.app_id IS NOT NULL
							AND (licenses.activation_usage_reset_at IS NULL OR ual.created_at > licenses.activation_usage_reset_at)
					) AS normal_activation_used,
					(
						SELECT COUNT(*)
						FROM premium_activations pa
						WHERE pa.license_id = licenses.id
							AND pa.status IN ('reserved', 'active', 'expired')
							AND (licenses.activation_usage_reset_at IS NULL OR pa.created_at > licenses.activation_usage_reset_at)
					) AS premium_activation_used,
					recovery_pin_hash,
					recovery_notice_accepted_at,
					hwid,
					expires_at,
					status,
					revoked_reason,
					revoked_origin,
					revoked_event_id,
					customer_id,
					access_type,
					billing_status,
					stripe_customer_id,
					stripe_subscription_id,
					stripe_checkout_session_id,
					billing_current_period_end,
					billing_current_period_start,
					billing_cancel_at_period_end,
					created_at,
					updated_at
				FROM licenses
				WHERE id = ?
			`,
		)
		.bind(id)
		.first<LicenseRecord>();

	if (!license) {
		throw new HTTPException(404, { message: "License not found" });
	}

	return license;
}
