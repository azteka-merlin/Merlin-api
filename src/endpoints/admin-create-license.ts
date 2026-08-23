import { OpenAPIRoute } from "chanfana";
import {
	type AppContext,
	CreateLicenseRequest,
	LicenseResponse,
} from "../types";
import { mapLicenseResponse, requireAdminToken } from "../lib/licenses";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import { createLicense } from "../lib/admin-license-service";

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
							contact: "11999999999",
							contactType: "phone",
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
							contact: "11999999999",
							contactType: "phone",
							source: "admin",
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
		const created = await createLicense(c, data.body);

		return c.json(mapLicenseResponse(created), 201);
	}
}
