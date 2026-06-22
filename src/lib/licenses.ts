import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type LicenseRecord = {
	id: number;
	license_key: string;
	name: string;
	phone: string;
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
		phone: record.phone,
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
					phone,
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
