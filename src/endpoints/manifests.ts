import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "../lib/auth";
import { getRequiredManifestOverride, isZipHeader } from "../lib/overrides";
import { enforceManifestsRateLimit } from "../lib/rate-limit";
import { writeUserActivityLog } from "../lib/user-activity-service";
import { type AppContext, ManifestQuery } from "../types";

type ManifestEnv = {
	DEPOTBOX_API_KEY?: string;
	RYU_API_URL?: string;
	RYUU_AUTH_CODE?: string;
	HUBCAP_TOKEN?: string;
	MERLIN_FILES?: R2Bucket;
};

type ManifestSource = {
	name: string;
	url: string;
	init: RequestInit;
	maxAttempts: number;
	timeoutMs?: number;
};

type LicenseLookup = {
	id: number;
	license_key: string;
	name: string;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked";
};

const USER_AGENT = "Merlin/2.0";
const RETRY_DELAY_MS = 750;
const SOURCE_TIMEOUT_MS = 10_000;
const FALLBACK_SOURCE_TIMEOUT_MS = 5_000;
const DEPOTBOX_DIRECT_DOWNLOAD_URL = "https://depotbox.org/api/direct-download";

function parseBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;

	const [scheme, token] = header.split(" ");
	return scheme === "Bearer" && token ? token : null;
}

function getClientIp(c: AppContext): string | null {
	return c.req.header("cf-connecting-ip")?.trim() || c.req.header("x-real-ip")?.trim() || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function buildZipResponse(body: BodyInit, appId: string, sourceName: string): Response {
	const headers = new Headers();
	headers.set("cache-control", "no-store");
	headers.set("content-type", "application/zip");
	headers.set("content-disposition", `attachment; filename="${appId}.zip"`);
	headers.set("x-merlin-manifest-source", sourceName);
	return new Response(body, { status: 200, headers });
}

async function validatedZipResponse(response: Response): Promise<Response | null> {
	if (!response.body) return null;

	const reader = response.body.getReader();
	const first = await reader.read();
	if (first.done || !first.value || !isZipHeader(first.value)) {
		await reader.cancel();
		return null;
	}

	let firstChunk: Uint8Array | null = first.value;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (firstChunk) {
				controller.enqueue(firstChunk);
				firstChunk = null;
				return;
			}

			const chunk = await reader.read();
			if (chunk.done) {
				controller.close();
				return;
			}
			controller.enqueue(chunk.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});

	return new Response(body, {
		status: response.status,
		headers: response.headers,
	});
}

async function fetchSource(source: ManifestSource): Promise<Response | null> {
	for (let attempt = 1; attempt <= source.maxAttempts; attempt += 1) {
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort("timeout"), source.timeoutMs || SOURCE_TIMEOUT_MS);
		try {
			const response = await fetch(source.url, {
				...source.init,
				signal: controller.signal,
			});
			if (response.ok) {
				const zipResponse = await validatedZipResponse(response);
				if (zipResponse) {
					console.info(`${source.name} returned HTTP ${response.status}`);
					return zipResponse;
				}
				console.warn(`${source.name} returned a non-ZIP payload`);
				return null;
			}

			console.warn(`${source.name} returned HTTP ${response.status}`);
			await response.body?.cancel();
			if (!isRetryableStatus(response.status)) return null;
		} catch (error) {
			console.warn(`${source.name} request failed:`, error instanceof Error ? error.message : "unknown error");
		} finally {
			clearTimeout(timeoutHandle);
		}

		if (attempt < source.maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
		}
	}

	return null;
}

function createSources(appId: string, env: ManifestEnv): ManifestSource[] {
	const commonHeaders = {
		"User-Agent": USER_AGENT,
		Accept: "application/zip, application/octet-stream",
	};
	const sources: ManifestSource[] = [];

	if (env.RYU_API_URL && env.RYUU_AUTH_CODE) {
		const ryuUrl = new URL(env.RYU_API_URL);
		ryuUrl.searchParams.set("appid", appId);
		ryuUrl.searchParams.set("auth_code", env.RYUU_AUTH_CODE);
		sources.push({
			name: "ryu",
			url: ryuUrl.toString(),
			init: { headers: commonHeaders },
			maxAttempts: 1,
			timeoutMs: SOURCE_TIMEOUT_MS,
		});
	}

	if (env.DEPOTBOX_API_KEY) {
		sources.push({
			name: "depotbox",
			url: DEPOTBOX_DIRECT_DOWNLOAD_URL,
			init: {
				method: "POST",
				headers: {
					...commonHeaders,
					"Content-Type": "application/json",
					"X-API-Key": env.DEPOTBOX_API_KEY,
				},
				body: JSON.stringify({ appid: appId }),
			},
			maxAttempts: 1,
			timeoutMs: SOURCE_TIMEOUT_MS,
		});
	}

	if (env.HUBCAP_TOKEN) {
		sources.push({
			name: "hubcap",
			url: `https://hubcapmanifest.com/api/v1/manifest/${appId}`,
			init: {
				headers: {
					...commonHeaders,
					Authorization: `Bearer ${env.HUBCAP_TOKEN}`,
				},
			},
			maxAttempts: 1,
			timeoutMs: SOURCE_TIMEOUT_MS,
		});
	}

	sources.push({
		name: "skyflare",
		url: `https://raw.githubusercontent.com/skyflarefox/Skyapi/refs/heads/main/${appId}.zip`,
		init: { headers: commonHeaders },
		maxAttempts: 1,
		timeoutMs: FALLBACK_SOURCE_TIMEOUT_MS,
	});

	const githubUrls = [
		`https://codeload.github.com/SPIN0ZAi/SB_manifest_DB/zip/refs/heads/${appId}`,
		`https://github.com/SPIN0ZAi/SB_manifest_DB/archive/refs/heads/${appId}.zip`,
		`https://api.github.com/repos/SPIN0ZAi/SB_manifest_DB/zipball/${appId}`,
	];
	for (const [index, url] of githubUrls.entries()) {
		sources.push({
			name: `github-${index + 1}`,
			url,
			init: { headers: commonHeaders },
			maxAttempts: 1,
			timeoutMs: FALLBACK_SOURCE_TIMEOUT_MS,
		});
	}

	return sources;
}

export class ManifestsRoute extends OpenAPIRoute {
	schema: any = {
		tags: ["Manifests"],
		summary: "Download manifests using the authenticated fallback chain",
		security: [{ bearerAuth: [] }],
		request: {
			query: ManifestQuery,
		},
		responses: {
			"200": {
				description: "Returns the manifests ZIP from the first available source",
				content: {
					"application/zip": {
						schema: { type: "string", format: "binary" },
					},
				},
			},
			"401": {
				description: "Missing, invalid or expired access token",
			},
			"429": {
				description: "Too many manifest requests for the current license",
			},
			"502": {
				description: "No manifest source returned a valid ZIP or a required override could not be prepared",
			},
		},
	};

	async handle(c: AppContext) {
		const accessToken = parseBearerToken(c.req.raw);
		if (!accessToken) {
			throw new HTTPException(401, { message: "Missing access token" });
		}

		if (!c.env.JWT_SECRET) {
			throw new HTTPException(500, { message: "JWT secret is not configured" });
		}

		const tokenPayload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
		if (tokenPayload.exp <= Math.floor(Date.now() / 1000)) {
			throw new HTTPException(401, { message: "Access token expired" });
		}

		const license = await c.env.merlin_db
			.prepare(
				`
					SELECT id, license_key, name, hwid, expires_at, status
					FROM licenses
					WHERE id = ?
				`,
			)
			.bind(tokenPayload.sub)
			.first<LicenseLookup>();

		if (!license) {
			throw new HTTPException(401, { message: "License not found" });
		}
		if (license.status !== "active") {
			throw new HTTPException(401, { message: "License is not active" });
		}
		if (!license.hwid || license.hwid !== tokenPayload.hwid) {
			throw new HTTPException(401, { message: "HWID mismatch" });
		}

		const expiresAt = new Date(license.expires_at);
		if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
			throw new HTTPException(401, { message: "License expired" });
		}

		await enforceManifestsRateLimit(c, license.id);

		const data = await this.getValidatedData<typeof this.schema>();
		const appId = data.query?.appid;
		if (!appId) {
			throw new HTTPException(400, { message: "Missing appid" });
		}

		const clientIp = getClientIp(c);
		const env = c.env as Env & ManifestEnv;
		const override = await getRequiredManifestOverride(env, appId);
		if (override) {
			await writeUserActivityLog(c, {
				licenseId: license.id,
				licenseKey: license.license_key,
				userName: license.name,
				action: "game_activation_success",
				status: "success",
				appId,
				gameName: null,
				ipAddress: clientIp,
				hwid: tokenPayload.hwid,
				metadata: { source: "r2-override" },
			});
			return buildZipResponse(override.bytes, appId, "r2-override");
		}

		for (const source of createSources(appId, env)) {
			const response = await fetchSource(source);
			if (!response || !response.body) continue;

			await writeUserActivityLog(c, {
				licenseId: license.id,
				licenseKey: license.license_key,
				userName: license.name,
				action: "game_activation_success",
				status: "success",
				appId,
				gameName: null,
				ipAddress: clientIp,
				hwid: tokenPayload.hwid,
				metadata: { source: source.name },
			});

			return buildZipResponse(response.body, appId, source.name);
		}

		await writeUserActivityLog(c, {
			licenseId: license.id,
			licenseKey: license.license_key,
			userName: license.name,
			action: "game_activation_denied",
			status: "denied",
			appId,
			gameName: null,
			ipAddress: clientIp,
			hwid: tokenPayload.hwid,
			reason: "manifest_unavailable",
		});

		return c.json({ error: "No manifest source returned a valid ZIP" }, 502);
	}
}
