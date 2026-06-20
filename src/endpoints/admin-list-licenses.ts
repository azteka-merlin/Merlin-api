import { OpenAPIRoute } from "chanfana";
import { mapLicenseResponse, requireAdminToken } from "../lib/licenses";
import type { AppContext } from "../types";
import { LicenseListResponse } from "../types";

export class AdminListLicensesRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "List all licenses",
		security: [
			{
				bearerAuth: [],
			},
		],
		responses: {
			"200": {
				description: "Returns all licenses",
				content: {
					"application/json": {
						schema: LicenseListResponse,
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
		},
	};

	async handle(c: AppContext) {
		requireAdminToken(c);

		const result = await c.env.merlin_db
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
					ORDER BY id DESC
				`,
			)
			.all<{
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
			}>();

		return c.json(
			{
				licenses: result.results.map(mapLicenseResponse),
			},
			200,
		);
	}
}
