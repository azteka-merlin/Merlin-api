import { OpenAPIRoute } from "chanfana";
import { requireAdminToken } from "../lib/licenses";
import { readOverrides } from "../lib/overrides";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import type { AppContext } from "../types";
import { OverrideListResponse } from "../types";

export class AdminListOverridesRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "List all configured R2 overrides",
		security: [
			{
				bearerAuth: [],
			},
		],
		responses: {
			"200": {
				description: "Returns all configured overrides",
				content: {
					"application/json": {
						schema: OverrideListResponse,
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

		return c.json(
			{
				overrides: await readOverrides(c.env),
			},
			200,
		);
	}
}
