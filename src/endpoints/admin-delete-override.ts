import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { requireAdminToken } from "../lib/licenses";
import { deleteOverride } from "../lib/overrides";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import type { AppContext } from "../types";
import { DeleteOverrideResponse, OverrideParams } from "../types";

export class AdminDeleteOverrideRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "Delete an override entry",
		security: [
			{
				bearerAuth: [],
			},
		],
		request: {
			params: OverrideParams,
		},
		responses: {
			"200": {
				description: "Override removed successfully",
				content: {
					"application/json": {
						schema: DeleteOverrideResponse,
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
			"404": {
				description: "Override not found",
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
		const appId = data.params?.appId;
		if (!appId) {
			throw new HTTPException(400, { message: "Missing appId" });
		}

		const removed = await deleteOverride(c.env, appId);
		if (!removed) {
			throw new HTTPException(404, { message: "Override not found" });
		}

		return c.json(
			{
				success: true,
				appId,
			},
			200,
		);
	}
}
