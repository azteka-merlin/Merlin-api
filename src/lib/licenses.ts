import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type LicenseRecord = {
	id: number;
	license_key: string;
	name: string;
	contact: string;
	contact_type: "phone" | "email" | "discord";
	source: "admin" | "public_signup" | "purchase" | "gift" | "manual_import";
	recovery_pin_hash: string | null;
	recovery_notice_accepted_at: string | null;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked";
	revoked_reason: string | null;
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

export function toDateOnly(value: string): string {
	return value.slice(0, 10);
}

export function mapLicenseResponse(record: LicenseRecord) {
	return {
		id: record.id,
		licenseKey: record.license_key,
		name: record.name,
		contact: record.contact,
		contactType: record.contact_type,
		source: record.source,
		hasRecoveryPin: Boolean(record.recovery_pin_hash),
		recoveryNoticeAcceptedAt: record.recovery_notice_accepted_at,
		phone: record.contact,
		hwid: record.hwid,
		expiresAt: toDateOnly(record.expires_at),
		status: record.status,
		revokedReason: record.revoked_reason,
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
					recovery_pin_hash,
					recovery_notice_accepted_at,
					hwid,
					expires_at,
					status,
					revoked_reason,
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
