import { OpenAPIRoute } from "chanfana";
import { type AppContext, HealthResponse } from "../types";

export class HealthRoute extends OpenAPIRoute {
	schema = {
		tags: ["System"],
		summary: "Health check",
		responses: {
			"200": {
				description: "Returns the service health status",
				content: {
					"application/json": {
						schema: HealthResponse,
					},
				},
			},
		},
	};

	async handle(_c: AppContext) {
		return {
			status: "online",
		};
	}
}
