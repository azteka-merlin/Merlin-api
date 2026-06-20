import { OpenAPIRoute } from "chanfana";
import {
	getLicenseById,
	mapLicenseResponse,
	requireAdminToken,
	toIsoDateStart,
} from "../lib/licenses";
import {
	type AppContext,
	LicenseParams,
	LicenseResponse,
	RenewLicenseRequest,
} from "../types";

export class AdminRenewLicenseRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Renew a license",
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
						schema: RenewLicenseRequest,
						example: {
							expiresAt: "2026-08-20",
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns the renewed license",
				content: {
					"application/json": {
						schema: LicenseResponse,
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
			"404": {
				description: "License not found",
			},
		},
	};

	async handle(c: AppContext) {
		requireAdminToken(c);

		const data = await this.getValidatedData<typeof this.schema>();
		await getLicenseById(c, data.params.id);

		await c.env.merlin_db
			.prepare(
				`
					UPDATE licenses
					SET expires_at = ?, status = 'active', revoked_reason = NULL, updated_at = ?
					WHERE id = ?
				`,
			)
			.bind(toIsoDateStart(data.body.expiresAt), new Date().toISOString(), data.params.id)
			.run();

		const renewed = await getLicenseById(c, data.params.id);
		return c.json(mapLicenseResponse(renewed), 200);
	}
}
