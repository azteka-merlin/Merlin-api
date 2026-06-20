import { OpenAPIRoute } from "chanfana";
import { type AppContext, VersionResponse } from "../types";

const APP_VERSION = "0.0.1";

export class VersionRoute extends OpenAPIRoute {
	schema = {
		tags: ["System"],
		summary: "Get API version",
		responses: {
			"200": {
				description: "Returns the service name and version",
				content: {
					"application/json": {
						schema: VersionResponse,
					},
				},
			},
		},
	};

	async handle(_c: AppContext) {
		return {
			name: "merlin-api",
			version: APP_VERSION,
		};
	}
}
