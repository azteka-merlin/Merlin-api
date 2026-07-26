import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { getFixOverrideFile, isZipHeader } from "../lib/overrides";
import { FixDownloadQuery, type AppContext } from "../types";

const DEPOTBOX_DIRECT_DOWNLOAD_URL = "https://depotbox.org/api/direct-download";
const RYUU_FIXES_CATALOG_URL = "https://generator.ryuu.lol/files/fixes.json";

function contentTypeFromFile(file: string): string {
	if (file.endsWith(".rar")) return "application/vnd.rar";
	if (file.endsWith(".zip")) return "application/zip";
	return "application/octet-stream";
}

type RyuuFix = {
	href?: string;
	filename?: string;
	size?: string;
	badges?: unknown[];
};

type RyuuFixEntry = {
	appid?: string | number;
	fixes?: RyuuFix[];
};

function firstEligibleRyuuFix(fixes: unknown): { href: string; filename: string } | null {
	if (!Array.isArray(fixes)) return null;

	for (const fix of fixes) {
		if (!fix || typeof fix !== "object" || Array.isArray(fix)) continue;
		const candidate = fix as RyuuFix;
		const badges = Array.isArray(candidate.badges)
			? candidate.badges.map((value) => String(value || "").trim().toLocaleLowerCase())
			: [];
		if (badges.includes("hypervisor")) continue;

		const href = typeof candidate.href === "string" ? candidate.href.trim() : "";
		const filename = typeof candidate.filename === "string" ? candidate.filename.trim() : "";
		if (!href || !filename) continue;

		try {
			const url = new URL(href);
			if (url.origin !== "https://generator.ryuu.lol" || !url.pathname.startsWith("/fixes/")) {
				continue;
			}
		} catch {
			continue;
		}

		return { href, filename };
	}

	return null;
}

async function findRyuuFix(appId: string): Promise<{ href: string; filename: string } | null> {
	const response = await fetch(RYUU_FIXES_CATALOG_URL, {
		headers: {
			"User-Agent": "Merlin/2.0",
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		console.warn("[fixes-download] ryuu catalog returned HTTP", response.status);
		throw new HTTPException(502, { message: "Could not load the correction file" });
	}

	const entries = await response.json();
	if (!Array.isArray(entries)) {
		throw new HTTPException(502, { message: "Could not load the correction file" });
	}

	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const candidate = entry as RyuuFixEntry;
		if (String(candidate.appid || "").trim() !== appId) continue;
		return firstEligibleRyuuFix(candidate.fixes);
	}

	return null;
}

async function proxyRyuuArchive(c: AppContext, appId: string) {
	const authCode = typeof c.env.RYUU_AUTH_CODE === "string" ? c.env.RYUU_AUTH_CODE.trim() : "";
	if (!authCode) {
		throw new HTTPException(502, { message: "Ryuu auth code is not configured" });
	}

	const fix = await findRyuuFix(appId);
	if (!fix) {
		throw new HTTPException(404, { message: "Correction not found" });
	}

	const url = new URL(fix.href);
	url.searchParams.set("auth_code", authCode);

	const response = await fetch(url.toString(), {
		headers: {
			"User-Agent": "Merlin/2.0",
			Accept: "application/zip, application/vnd.rar, application/octet-stream",
		},
	});

	if (!response.ok || !response.body) {
		console.warn("[fixes-download] ryuu returned HTTP", response.status);
		throw new HTTPException(502, { message: "Could not load the correction file" });
	}

	const headers = new Headers();
	headers.set("cache-control", "no-store");
	headers.set("content-type", contentTypeFromFile(fix.filename));
	headers.set("content-disposition", `attachment; filename="${fix.filename}"`);
	headers.set("x-merlin-fix-source", "ryuu");

	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		headers.set("content-length", contentLength);
	}

	return new Response(response.body, { status: 200, headers });
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
		summary: "Download a correction file from R2, Ryuu or DepotBox",
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
		const source = data.query?.source === "depotbox" || data.query?.source === "ryuu"
			? data.query.source
			: "override";
		if (!appId) {
			throw new HTTPException(400, { message: "Missing appid" });
		}

		if (source === "depotbox") {
			return proxyDepotboxArchive(c, appId);
		}

		if (source === "ryuu") {
			return proxyRyuuArchive(c, appId);
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
