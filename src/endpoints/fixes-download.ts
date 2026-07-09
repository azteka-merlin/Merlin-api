import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { getFixOverrideFile, isZipHeader } from "../lib/overrides";
import { FixDownloadQuery, type AppContext } from "../types";

const DEPOTBOX_DIRECT_DOWNLOAD_URL = "https://depotbox.org/api/direct-download";

function contentTypeFromFile(file: string): string {
	if (file.endsWith(".rar")) return "application/vnd.rar";
	if (file.endsWith(".zip")) return "application/zip";
	return "application/octet-stream";
}

async function proxyDepotboxArchive(c: AppContext, appId: string) {
	const apiKey = typeof c.env.DEPOTBOX_API_KEY === "string" ? c.env.DEPOTBOX_API_KEY.trim() : "";
	if (!apiKey) {
		throw new HTTPException(502, { message: "DepotBox API key is not configured" });
	}

	const response = await fetch(DEPOTBOX_DIRECT_DOWNLOAD_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": apiKey,
			"User-Agent": "Merlin/2.0",
			Accept: "application/zip, application/octet-stream",
		},
		body: JSON.stringify({ appid: appId }),
	});

	if (!response.ok) {
		console.warn("[fixes-download] depotbox returned HTTP", response.status);
		throw new HTTPException(502, { message: "Could not load the correction file" });
	}

	const archiveBytes = new Uint8Array(await response.arrayBuffer());
	if (!isZipHeader(archiveBytes)) {
		console.warn("[fixes-download] depotbox returned a non-ZIP payload");
		throw new HTTPException(502, { message: "Could not load the correction file" });
	}

	const headers = new Headers();
	headers.set("cache-control", "no-store");
	headers.set("content-type", "application/zip");
	headers.set("content-disposition", `attachment; filename="${appId}.zip"`);
	headers.set("x-merlin-fix-source", "depotbox");
	return new Response(archiveBytes, { status: 200, headers });
}

export class FixesDownloadRoute extends OpenAPIRoute {
	schema = {
		tags: ["Fixes"],
		summary: "Download an override correction file from R2 or DepotBox",
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
		const source = data.query?.source === "depotbox" ? "depotbox" : "override";
		if (!appId) {
			throw new HTTPException(400, { message: "Missing appid" });
		}

		if (source === "depotbox") {
			return proxyDepotboxArchive(c, appId);
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
