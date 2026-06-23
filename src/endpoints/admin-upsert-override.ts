import { OpenAPIRoute } from "chanfana";
import { requireAdminToken } from "../lib/licenses";
import { upsertOverride } from "../lib/overrides";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import type { AppContext } from "../types";
import { OverrideResponse, OverrideUpsertRequest } from "../types";

export class AdminUpsertOverrideRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Create or update an override entry",
		security: [
			{
				bearerAuth: [],
			},
		],
		request: {
			body: {
				content: {
					"application/json": {
						schema: OverrideUpsertRequest,
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns the updated override entry",
				content: {
					"application/json": {
						schema: OverrideResponse,
					},
				},
			},
			"400": {
				description: "Invalid override payload",
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
		const body = data.body;
		const appId = body?.appId;
		if (!appId) {
			return c.json({ error: "Missing appId" }, 400);
		}

		const override = await upsertOverride(c.env, appId, {
			manifestOverride: body?.manifestOverride,
			fixOverride: body?.fixOverride,
		});

		return c.json(
			{
				appId,
				override,
			},
			200,
		);
	}
}
