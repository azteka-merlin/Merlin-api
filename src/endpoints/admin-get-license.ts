import { OpenAPIRoute } from "chanfana";
import { getLicenseById, mapLicenseResponse, requireAdminToken } from "../lib/licenses";
import { type AppContext, LicenseParams, LicenseResponse } from "../types";

export class AdminGetLicenseRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Get a license by id",
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
				description: "Returns the license",
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
		const license = await getLicenseById(c, data.params.id);

		return c.json(mapLicenseResponse(license), 200);
	}
}
