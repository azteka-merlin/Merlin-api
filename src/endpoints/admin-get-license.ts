import { OpenAPIRoute } from "chanfana";
import { getLicenseById, mapLicenseResponse, requireAdminToken } from "../lib/licenses";
import { enforceAdminRateLimit } from "../lib/rate-limit";
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
		const license = await getLicenseById(c, data.params.id);

		return c.json(mapLicenseResponse(license), 200);
	}
}
