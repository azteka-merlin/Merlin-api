import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "./auth";
import type { AppContext } from "../types";

export type LauncherLicense = {
	id: number;
	licenseKey: string;
	name: string;
	hwid: string;
	expiresAt: string;
};

type LicenseLookup = {
	id: number;
	license_key: string;
	name: string;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked";
};

export function parseBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;

	const [scheme, token] = header.split(" ");
	return scheme === "Bearer" && token ? token : null;
}

export async function requireLauncherLicense(c: AppContext): Promise<LauncherLicense> {
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

	const license = await c.env.merlin_db
		.prepare(
			`
				SELECT id, license_key, name, hwid, expires_at, status
				FROM licenses
				WHERE id = ?
				LIMIT 1
			`,
		)
		.bind(payload.sub)
		.first<LicenseLookup>();

	if (!license) {
		throw new HTTPException(401, { message: "License not found" });
	}
	if (license.status !== "active") {
		throw new HTTPException(401, { message: "License is not active" });
	}
	if (!license.hwid || license.hwid !== payload.hwid) {
		throw new HTTPException(401, { message: "HWID mismatch" });
	}

	const expiresAt = new Date(license.expires_at);
	if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
		throw new HTTPException(401, { message: "License expired" });
	}

	return {
		id: license.id,
		licenseKey: license.license_key,
		name: license.name,
		hwid: license.hwid,
		expiresAt: license.expires_at,
	};
}
