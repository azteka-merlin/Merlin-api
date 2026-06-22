import { OpenAPIRoute } from "chanfana";
import {
	type AppContext,
	CreateLicenseRequest,
	LicenseResponse,
} from "../types";
import {
	generateLicenseKey,
	getLicenseById,
	mapLicenseResponse,
	requireAdminToken,
	toIsoDateStart,
} from "../lib/licenses";
import { enforceAdminRateLimit } from "../lib/rate-limit";

export class AdminCreateLicenseRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Create a new Merlin license",
		description: "Creates a license record in D1 and returns the generated license key.",
		security: [
			{
				bearerAuth: [],
			},
		],
		request: {
			body: {
				content: {
					"application/json": {
						schema: CreateLicenseRequest,
						example: {
							name: "Fulano",
							phone: "11999999999",
							expiresAt: "2026-07-20",
						},
					},
				},
			},
		},
		responses: {
			"201": {
				description: "Returns the created license",
				content: {
					"application/json": {
						schema: LicenseResponse,
						example: {
							id: 1,
							licenseKey: "MERLIN-GJQZ-LTQ8-HE5G",
							name: "Fulano",
							phone: "11999999999",
							hwid: null,
							expiresAt: "2026-07-20",
							status: "active",
							revokedReason: null,
							createdAt: "2026-06-20T07:15:13.324Z",
							updatedAt: "2026-06-20T07:15:13.324Z",
						},
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
			"429": {
				description: "Too many administrative requests",
			},
		},
	};

	async handle(c: AppContext) {
		const adminKey = requireAdminToken(c);
		await enforceAdminRateLimit(c, adminKey);

		const data = await this.getValidatedData<typeof this.schema>();
		const now = new Date().toISOString();
		const expiresAt = toIsoDateStart(data.body.expiresAt);

		let licenseKey = generateLicenseKey();
		let insertResult: D1Result<Record<string, unknown>> | null = null;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const statement = c.env.merlin_db.prepare(
				`
					INSERT INTO licenses (
						license_key,
						name,
						phone,
						hwid,
						expires_at,
						status,
						revoked_reason,
						created_at,
						updated_at
					)
					VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
				`,
			);

			try {
				insertResult = await statement
					.bind(
						licenseKey,
						data.body.name,
						data.body.phone,
						null,
						expiresAt,
						null,
						now,
						now,
					)
					.run();
				break;
			} catch (error) {
				if (attempt === 4) {
					throw error;
				}

				licenseKey = generateLicenseKey();
			}
		}

		const createdId = Number(insertResult?.meta.last_row_id);
		const created = await getLicenseById(c, createdId);

		return c.json(mapLicenseResponse(created), 201);
	}
}
