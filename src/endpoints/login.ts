import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { signAccessToken } from "../lib/auth";
import { enforceLoginRateLimit } from "../lib/rate-limit";
import { type AppContext, LoginRequest, LoginResponse } from "../types";

const ACCESS_TOKEN_TTL_SECONDS = 3600;

function toDateOnly(value: string): string {
	return value.slice(0, 10);
}

type LicenseRecord = {
	id: number;
	license_key: string;
	name: string;
	phone: string;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked";
};

async function getLicenseByKey(c: AppContext, licenseKey: string): Promise<LicenseRecord | null> {
	return c.env.merlin_db
		.prepare(
			`
				SELECT
					id,
					license_key,
					name,
					phone,
					hwid,
					expires_at,
					status
				FROM licenses
				WHERE license_key = ?
			`,
		)
		.bind(licenseKey)
		.first<LicenseRecord>();
}

export class LoginRoute extends OpenAPIRoute {
	schema = {
		tags: ["Auth"],
		summary: "Validate a license and issue a session token",
		request: {
			body: {
				content: {
					"application/json": {
						schema: LoginRequest,
						example: {
							licenseKey: "MERLIN-GJQZ-LTQ8-HE5G",
							hwid: "DESKTOP-AZTEKA-ABC123",
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns a session token for a valid license",
				content: {
					"application/json": {
						schema: LoginResponse,
						example: {
							success: true,
							tokenType: "Bearer",
							accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsImh3aWQiOiJERVNLVE9QLUFaVEVLQS1BQkMxMjMiLCJ0eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzYwMDAwMDAwLCJqdGkiOiI2NmY4In0.signature",
							expiresIn: 3600,
							license: {
								name: "Fulano",
								expiresAt: "2026-07-20",
								status: "active",
							},
						},
					},
				},
			},
			"401": {
				description: "Invalid license, expired license or HWID mismatch",
			},
			"429": {
				description: "Too many login attempts from the current IP address",
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		await enforceLoginRateLimit(c, data.body);
		const now = new Date();

		if (!c.env.JWT_SECRET) {
			throw new HTTPException(500, { message: "JWT secret is not configured" });
		}

		const license = await getLicenseByKey(c, data.body.licenseKey);

		if (!license) {
			throw new HTTPException(401, { message: "Invalid license key" });
		}

		if (license.status !== "active") {
			throw new HTTPException(401, { message: "License is not active" });
		}

		const expiresAt = new Date(license.expires_at);
		if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < now.getTime()) {
			throw new HTTPException(401, { message: "License expired" });
		}

		let effectiveHwid = license.hwid;

		if (!effectiveHwid) {
			const updateResult = await c.env.merlin_db
				.prepare(
					`
						UPDATE licenses
						SET hwid = ?, updated_at = ?
						WHERE id = ?
					`,
				)
				.bind(data.body.hwid, now.toISOString(), license.id)
				.run();

			if (!updateResult.success) {
				throw new HTTPException(500, { message: "Could not bind this license to the current computer" });
			}

			const refreshedLicense = await getLicenseByKey(c, data.body.licenseKey);
			if (!refreshedLicense) {
				throw new HTTPException(401, { message: "Invalid license key" });
			}
			if (refreshedLicense.hwid !== data.body.hwid) {
				throw new HTTPException(500, { message: "The license HWID could not be confirmed after binding" });
			}

			effectiveHwid = refreshedLicense.hwid;
		} else if (effectiveHwid !== data.body.hwid) {
			throw new HTTPException(401, { message: "HWID mismatch" });
		}

		const accessToken = await signAccessToken(
			{
				sub: license.id,
				hwid: effectiveHwid,
				type: "access",
				exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
				jti: crypto.randomUUID(),
			},
			c.env.JWT_SECRET,
		);

		return c.json(
			{
				success: true,
				tokenType: "Bearer",
				accessToken,
				expiresIn: ACCESS_TOKEN_TTL_SECONDS,
				license: {
					name: license.name,
					expiresAt: toDateOnly(license.expires_at),
					status: license.status,
				},
			},
			200,
		);
	}
}
