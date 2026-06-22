import { OpenAPIRoute } from "chanfana";
import {
	getLicenseById,
	mapLicenseResponse,
	requireAdminToken,
} from "../lib/licenses";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import {
	type AppContext,
	LicenseParams,
	LicenseResponse,
	RevokeLicenseRequest,
} from "../types";

export class AdminRevokeLicenseRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Revoke a license",
		security: [
			{
				bearerAuth: [],
			},
		],
		request: {
			params: LicenseParams,
			body: {
				content: {
					"application/json": {
						schema: RevokeLicenseRequest,
						example: {
							reason: "Chargeback",
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns the revoked license",
				content: {
					"application/json": {
						schema: LicenseResponse,
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
			"429": {
				description: "Too many administrative requests",
			},
			"404": {
				description: "License not found",
			},
		},
	};

	async handle(c: AppContext) {
		const adminKey = requireAdminToken(c);
		await enforceAdminRateLimit(c, adminKey);

		const data = await this.getValidatedData<typeof this.schema>();
		await getLicenseById(c, data.params.id);

		await c.env.merlin_db
			.prepare(
				`
					UPDATE licenses
					SET status = 'revoked', revoked_reason = ?, updated_at = ?
					WHERE id = ?
				`,
			)
			.bind(data.body.reason, new Date().toISOString(), data.params.id)
			.run();

		const revoked = await getLicenseById(c, data.params.id);
		return c.json(mapLicenseResponse(revoked), 200);
	}
}
