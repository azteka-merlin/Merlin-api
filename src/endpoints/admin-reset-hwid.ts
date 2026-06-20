import { OpenAPIRoute } from "chanfana";
import {
	getLicenseById,
	mapLicenseResponse,
	requireAdminToken,
} from "../lib/licenses";
import { type AppContext, LicenseParams, LicenseResponse } from "../types";

export class AdminResetHwidRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Reset a license HWID",
		security: [
			{
				bearerAuth: [],
			},
		],
		request: {
			params: LicenseParams,
		},
		responses: {
			"200": {
				description: "Returns the license with cleared HWID",
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
					SET hwid = NULL, updated_at = ?
					WHERE id = ?
				`,
			)
			.bind(new Date().toISOString(), data.params.id)
			.run();

		const updated = await getLicenseById(c, data.params.id);
		return c.json(mapLicenseResponse(updated), 200);
	}
}
