import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { getFixOverrideFile } from "../lib/overrides";
import { FixDownloadQuery, type AppContext } from "../types";

function contentTypeFromFile(file: string): string {
	if (file.endsWith(".rar")) return "application/vnd.rar";
	if (file.endsWith(".zip")) return "application/zip";
	return "application/octet-stream";
}

export class FixesDownloadRoute extends OpenAPIRoute {
	schema = {
		tags: ["Fixes"],
		summary: "Download an override correction file from R2",
		request: {
			query: FixDownloadQuery,
		},
		responses: {
			"200": {
				description: "Returns the correction file",
			},
			"404": {
				description: "No override correction is configured for the requested game",
			},
			"502": {
				description: "Could not load the correction file",
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const appId = data.query?.appid;
		if (!appId) {
			throw new HTTPException(400, { message: "Missing appid" });
		}

		const override = await getFixOverrideFile(c.env, appId);
		if (!override) {
			throw new HTTPException(404, { message: "Correction not found" });
		}

		const headers = new Headers();
		headers.set("cache-control", "no-store");
		headers.set("content-type", contentTypeFromFile(override.file));
		headers.set("content-disposition", `attachment; filename="${override.filename}"`);
		headers.set("x-merlin-fix-source", "r2-override");

		return new Response(override.object.body, { status: 200, headers });
	}
}

