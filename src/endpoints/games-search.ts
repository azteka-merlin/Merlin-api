import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "../lib/auth";
import { type AppContext, GameSearchRequest, GameSearchResponse } from "../types";

type GameSearchEnv = {
	DEPOTBOX_API_KEY?: string;
	JWT_SECRET?: string;
};

type ViewerLicenseLookup = {
	id: number;
	hwid: string | null;
	expires_at: string;
	status: "active" | "revoked";
};

type DepotboxGame = {
	appid?: string | number;
	name?: string;
	is_dlc?: boolean;
	header_image_url?: string | null;
};

type FallbackCatalogGame = {
	appid?: string | number;
	name?: string;
	capsule_image?: string;
	header_image?: string;
};

type SteamBasicAppDetails = {
	success?: boolean;
	data?: {
		type?: string;
		name?: string;
		short_description?: string;
		header_image?: string;
		capsule_image?: string;
	};
};

type SearchItem = {
	appId: string;
	name: string;
	coverUrl: string | null;
	coverSource: string | null;
};

const USER_AGENT = "Merlin/2.0";
const DEPOTBOX_SEARCH_URL = "https://depotbox.org/api/search-games";
const FALLBACK_GAMES_CATALOG_URL = "https://generator.ryuu.lol/files/games.json";
const GAMES_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const SOURCE_IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const STEAM_NO_IMAGE_CACHE_TTL_MS = 60 * 1000;
const STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_INVALID_APP_TYPE = "__invalid__";
const SEARCH_SOURCE_TIMEOUT_MS = 3_000;
const STEAM_SEARCH_TIMEOUT_MS = 2_500;
const CATALOG_QUERY_MISS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEPOT_QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
const NON_PLAYABLE_NAME_PATTERNS = [
	/\bcreation kit\b/i,
	/\bscript extender\b/i,
	/\bdedicated server\b/i,
	/\bserver browser\b/i,
	/\bauthoring tools?\b/i,
	/\bmod tools?\b/i,
	/\bsdk\b/i,
	/\beditor\b/i,
	/\bdeluxe content\b/i,
	/\bsoundtrack\b/i,
	/\bartbook\b/i,
	/\bseason pass\b/i,
	/\bupgrade pack\b/i,
	/\blanguage pack\b/i,
	/\bcosmetic pack\b/i,
	/\bskin pack\b/i,
	/\bbonus content\b/i,
];
const NON_PLAYABLE_DESCRIPTION_PATTERNS = [
	/\brequires? .*base game\b/i,
	/\bbase game required\b/i,
	/\bdownloadable content\b/i,
];

let gamesCatalogCache: {
	expiresAt: number;
	items: SearchItem[];
} = {
	expiresAt: 0,
	items: [],
};

let sourceImageValidationCache = new Map<string, {
	expiresAt: number;
	ok: boolean;
}>();

let steamDetailsCache = new Map<string, {
	expiresAt: number;
	type: string | null;
	name: string | null;
	shortDescription: string | null;
	coverUrl: string | null;
	coverSource: string | null;
}>();

let catalogMissCache = new Map<string, number>();

let depotSearchCache = new Map<string, {
	expiresAt: number;
	items: SearchItem[];
}>();

function parseBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;

	const [scheme, token] = header.split(" ");
	return scheme === "Bearer" && token ? token : null;
}

async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit = {},
	timeoutMs = SEARCH_SOURCE_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort("timeout"), timeoutMs);

	try {
		return await fetch(input, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function normalizeSearchKey(searchTerm: string, limit: number): string {
	return `${String(searchTerm || "").trim().toLocaleLowerCase()}::${Math.max(1, Math.trunc(Number(limit) || 0))}`;
}

function hasFreshCatalogMiss(searchTerm: string, limit: number): boolean {
	const key = normalizeSearchKey(searchTerm, limit);
	const expiresAt = catalogMissCache.get(key) || 0;
	if (expiresAt > Date.now()) {
		return true;
	}
	catalogMissCache.delete(key);
	return false;
}

function recordCatalogMiss(searchTerm: string, limit: number): void {
	catalogMissCache.set(
		normalizeSearchKey(searchTerm, limit),
		Date.now() + CATALOG_QUERY_MISS_CACHE_TTL_MS
	);
}

function clearCatalogMiss(searchTerm: string, limit: number): void {
	catalogMissCache.delete(normalizeSearchKey(searchTerm, limit));
}

function getCachedDepotSearch(searchTerm: string, limit: number): SearchItem[] | null {
	const key = normalizeSearchKey(searchTerm, limit);
	const cached = depotSearchCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.items.map((item) => ({ ...item }));
	}
	depotSearchCache.delete(key);
	return null;
}

function setCachedDepotSearch(searchTerm: string, limit: number, items: SearchItem[]): void {
	depotSearchCache.set(normalizeSearchKey(searchTerm, limit), {
		expiresAt: Date.now() + DEPOT_QUERY_CACHE_TTL_MS,
		items: items.map((item) => ({ ...item })),
	});
}

function normalizeDepotboxGame(entry: unknown): SearchItem | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

	const candidate = entry as DepotboxGame;
	const appId = String(candidate.appid || "").trim();
	const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
	const isDlc = candidate.is_dlc === true;
	const headerImageUrl = typeof candidate.header_image_url === "string"
		? candidate.header_image_url.trim()
		: "";

	if (!/^\d+$/.test(appId) || !name || isDlc) return null;

	return {
		appId,
		name,
		coverUrl: headerImageUrl || null,
		coverSource: headerImageUrl ? "depotbox_header_image" : null,
	};
}

function normalizeFallbackCatalogGame(entry: unknown): SearchItem | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

	const candidate = entry as FallbackCatalogGame;
	const appId = String(candidate.appid || "").trim();
	const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
	const capsuleImage = typeof candidate.capsule_image === "string" ? candidate.capsule_image.trim() : "";
	const headerImage = typeof candidate.header_image === "string" ? candidate.header_image.trim() : "";

	if (!/^\d+$/.test(appId) || !name) return null;

	const coverUrl = capsuleImage || headerImage || null;
	const coverSource = capsuleImage
		? "capsule_image"
		: headerImage
			? "header_image"
			: null;

	return {
		appId,
		name,
		coverUrl,
		coverSource,
	};
}

async function isUsableSourceCoverUrl(url: string): Promise<boolean> {
	url = String(url || "").trim();
	if (!url) return false;

	const cached = sourceImageValidationCache.get(url);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.ok;
	}

	let ok = false;

	try {
		let response = await fetchWithTimeout(url, {
			method: "HEAD",
			headers: {
				Accept: "image/*",
				"User-Agent": USER_AGENT,
			},
		}, STEAM_SEARCH_TIMEOUT_MS);

		if (!response.ok && (response.status === 403 || response.status === 405)) {
			await response.body?.cancel();
			response = await fetchWithTimeout(url, {
				headers: {
					Accept: "image/*",
					Range: "bytes=0-0",
					"User-Agent": USER_AGENT,
				},
			}, STEAM_SEARCH_TIMEOUT_MS);
		}

		const contentType = String(response.headers.get("content-type") || "").trim().toLocaleLowerCase();
		ok = response.ok && (!contentType || contentType.startsWith("image/"));
		await response.body?.cancel();
	} catch {
		ok = false;
	}

	sourceImageValidationCache.set(url, {
		expiresAt: Date.now() + SOURCE_IMAGE_CACHE_TTL_MS,
		ok,
	});

	return ok;
}

function scoreMatch(game: SearchItem, normalizedQuery: string): number {
	const name = game.name.toLocaleLowerCase();
	const appId = game.appId;
	if (!normalizedQuery) return -1;
	if (appId === normalizedQuery) return 4000;
	if (name.startsWith(normalizedQuery)) return 3000 - name.length;
	if (name.includes(normalizedQuery)) return 2000 - name.indexOf(normalizedQuery);
	if (/^\d+$/.test(normalizedQuery) && appId.startsWith(normalizedQuery)) return 1000 - appId.length;
	return -1;
}

function pushTopCatalogMatch(
	matches: Array<SearchItem & { score: number }>,
	candidate: SearchItem & { score: number },
	limit: number
): void {
	let insertAt = matches.length;
	for (let index = 0; index < matches.length; index += 1) {
		const current = matches[index];
		if (!current) continue;
		if (
			candidate.score > current.score
			|| (
				candidate.score === current.score
				&& (
					candidate.name.localeCompare(current.name) < 0
					|| (
						candidate.name === current.name
						&& candidate.appId.localeCompare(current.appId) < 0
					)
				)
			)
		) {
			insertAt = index;
			break;
		}
	}

	if (insertAt >= limit && matches.length >= limit) {
		return;
	}

	matches.splice(insertAt, 0, candidate);
	if (matches.length > limit) {
		matches.length = limit;
	}
}

function findTopCatalogMatches(items: SearchItem[], normalizedQuery: string, limit: number): SearchItem[] {
	const safeLimit = Math.max(1, Math.trunc(Number(limit) || 0));
	const matches: Array<SearchItem & { score: number }> = [];

	for (const item of items) {
		const score = scoreMatch(item, normalizedQuery);
		if (score < 0) continue;
		pushTopCatalogMatch(matches, { ...item, score }, safeLimit);
	}

	return matches.map(({ score, ...item }) => item);
}

function matchesDepotHeavyFilters(details: {
	name: string | null;
	shortDescription: string | null;
}): boolean {
	const name = String(details.name || "").trim();
	const shortDescription = String(details.shortDescription || "").trim();
	const haystack = `${name} ${shortDescription}`;

	if (NON_PLAYABLE_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(shortDescription))) {
		return true;
	}

	return NON_PLAYABLE_NAME_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isLikelyPlayableDepotCandidate(details: {
	type: string | null;
	name: string | null;
	shortDescription: string | null;
}): boolean {
	const type = String(details.type || "").trim().toLocaleLowerCase();
	if (type && type !== "game") {
		return false;
	}

	return !matchesDepotHeavyFilters(details);
}

async function enrichWithSteamMetadata(items: SearchItem[]): Promise<SearchItem[]> {
	if (items.length === 0) {
		return items;
	}

	const now = Date.now();
	const appIdsToFetch = [...new Set(
		items
			.map((item) => item.appId)
			.filter((appId) => {
				const cached = steamDetailsCache.get(appId);
				const sourceItem = items.find((item) => item.appId === appId);
				const sourceHasCover = Boolean(sourceItem?.coverUrl);
				return !cached
					|| cached.expiresAt <= now
					|| !cached.type
					|| (!cached.coverUrl && !sourceHasCover);
			})
	)];

	if (appIdsToFetch.length > 0) {
		try {
			const url = new URL(STEAM_APPDETAILS_URL);
			url.searchParams.set("appids", appIdsToFetch.join(","));
			url.searchParams.set("filters", "basic");

			const response = await fetchWithTimeout(url.toString(), {
				headers: {
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				},
			}, STEAM_SEARCH_TIMEOUT_MS);

			if (response.ok) {
				const payload = await response.json() as Record<string, SteamBasicAppDetails>;
				for (const appId of appIdsToFetch) {
					const details = payload?.[appId];
					const hasBasicData = details?.success === true && details?.data;
					const type = hasBasicData
						? typeof details.data?.type === "string"
							? details.data.type.trim().toLocaleLowerCase()
							: null
						: STEAM_INVALID_APP_TYPE;
					const name = typeof details?.data?.name === "string"
						? details.data.name.trim()
						: null;
					const shortDescription = typeof details?.data?.short_description === "string"
						? details.data.short_description.trim()
						: null;
					const capsuleImage = typeof details?.data?.capsule_image === "string"
						? details.data.capsule_image.trim()
						: "";
					const headerImage = typeof details?.data?.header_image === "string"
						? details.data.header_image.trim()
						: "";
					const coverUrl = capsuleImage || headerImage || null;
					const coverSource = capsuleImage
						? "steam_capsule_image"
						: headerImage
							? "steam_header_image"
							: null;

					steamDetailsCache.set(appId, {
						expiresAt: now + (coverUrl ? GAMES_CATALOG_CACHE_TTL_MS : STEAM_NO_IMAGE_CACHE_TTL_MS),
						type,
						name,
						shortDescription,
						coverUrl,
						coverSource,
					});
				}
			} else {
				console.warn(`[games-search] steam appdetails returned HTTP ${response.status}`);
				await response.body?.cancel();
			}
		} catch (error) {
			console.warn("[games-search] steam appdetails request failed:", error instanceof Error ? error.message : "unknown error");
		}
	}

	return Promise.all(
		items.map(async (item) => {
			const cached = steamDetailsCache.get(item.appId);
			if (cached?.coverUrl) {
				return {
					...item,
					name: cached.name || item.name,
					coverUrl: cached.coverUrl,
					coverSource: cached.coverSource,
				};
			}

			const sourceCoverUrl = typeof item.coverUrl === "string" ? item.coverUrl.trim() : "";
			if (sourceCoverUrl && await isUsableSourceCoverUrl(sourceCoverUrl)) {
				return {
					...item,
					name: cached?.name || item.name,
					coverUrl: sourceCoverUrl,
					coverSource: item.coverSource || null,
				};
			}

			return {
				...item,
				name: cached?.name || item.name,
				coverUrl: null,
				coverSource: null,
			};
		})
	);
}

async function validateDepotboxResultsWithSteam(items: SearchItem[]): Promise<SearchItem[]> {
	if (items.length === 0) {
		return [];
	}

	const now = Date.now();
	const appIdsToFetch = [...new Set(
		items
			.map((item) => item.appId)
			.filter((appId) => {
				const cached = steamDetailsCache.get(appId);
				return !cached || cached.expiresAt <= now || !cached.type;
			})
	)];

	let steamFetchSucceeded = appIdsToFetch.length === 0;
	if (appIdsToFetch.length > 0) {
		try {
			const url = new URL(STEAM_APPDETAILS_URL);
			url.searchParams.set("appids", appIdsToFetch.join(","));
			url.searchParams.set("filters", "basic");

			const response = await fetchWithTimeout(url.toString(), {
				headers: {
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				},
			}, STEAM_SEARCH_TIMEOUT_MS);

			if (response.ok) {
				steamFetchSucceeded = true;
				const payload = await response.json() as Record<string, SteamBasicAppDetails>;
				for (const appId of appIdsToFetch) {
					const details = payload?.[appId];
					const hasBasicData = details?.success === true && details?.data;
					const type = hasBasicData
						? typeof details.data?.type === "string"
							? details.data.type.trim().toLocaleLowerCase()
							: null
						: STEAM_INVALID_APP_TYPE;
					const name = typeof details?.data?.name === "string"
						? details.data.name.trim()
						: null;
					const shortDescription = typeof details?.data?.short_description === "string"
						? details.data.short_description.trim()
						: null;
					const capsuleImage = typeof details?.data?.capsule_image === "string"
						? details.data.capsule_image.trim()
						: "";
					const headerImage = typeof details?.data?.header_image === "string"
						? details.data.header_image.trim()
						: "";
					const coverUrl = capsuleImage || headerImage || null;
					const coverSource = capsuleImage
						? "steam_capsule_image"
						: headerImage
							? "steam_header_image"
							: null;

					steamDetailsCache.set(appId, {
						expiresAt: now + (coverUrl ? GAMES_CATALOG_CACHE_TTL_MS : STEAM_NO_IMAGE_CACHE_TTL_MS),
						type,
						name,
						shortDescription,
						coverUrl,
						coverSource,
					});
				}
			} else {
				console.warn(`[games-search] steam validation returned HTTP ${response.status}`);
				await response.body?.cancel();
			}
		} catch (error) {
			console.warn("[games-search] steam validation request failed:", error instanceof Error ? error.message : "unknown error");
		}
	}

	const validatedItems = items.filter((item) => {
		const cached = steamDetailsCache.get(item.appId);
		if (cached) {
			return isLikelyPlayableDepotCandidate(cached);
		}

		return !matchesDepotHeavyFilters({
			name: item.name,
			shortDescription: null,
		});
	});

	if (!steamFetchSucceeded && validatedItems.length > 0) {
		console.warn("[games-search] depotbox fallback is using heavy-filtered results because Steam validation is unavailable");
	}

	return Promise.all(
		validatedItems.map(async (item) => {
			const cached = steamDetailsCache.get(item.appId);
			const sourceCoverUrl = typeof item.coverUrl === "string" ? item.coverUrl.trim() : "";

			if (cached?.coverUrl) {
				return {
					...item,
					name: cached.name || item.name,
					coverUrl: cached.coverUrl,
					coverSource: cached.coverSource,
				};
			}

			if (sourceCoverUrl && await isUsableSourceCoverUrl(sourceCoverUrl)) {
				return {
					...item,
					name: cached?.name || item.name,
					coverUrl: sourceCoverUrl,
					coverSource: item.coverSource || null,
				};
			}

			return {
				...item,
				name: cached?.name || item.name,
				coverUrl: null,
				coverSource: null,
			};
		})
	);
}

async function requireActiveViewerLicense(c: AppContext): Promise<void> {
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
				SELECT id, hwid, expires_at, status
				FROM licenses
				WHERE id = ?
			`,
		)
		.bind(tokenPayload.sub)
		.first<ViewerLicenseLookup>();

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
}

async function searchDepotbox(env: GameSearchEnv, searchTerm: string, limit: number): Promise<SearchItem[]> {
	if (!env.DEPOTBOX_API_KEY) return [];

	const cached = getCachedDepotSearch(searchTerm, limit);
	if (cached) {
		return cached;
	}

	try {
		const response = await fetchWithTimeout(DEPOTBOX_SEARCH_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"X-API-Key": env.DEPOTBOX_API_KEY,
			},
			body: JSON.stringify({
				searchTerm,
				limit,
				filter_dlc: "exclude",
			}),
		}, SEARCH_SOURCE_TIMEOUT_MS);

		if (!response.ok) {
			console.warn(`[games-search] depotbox returned HTTP ${response.status}`);
			await response.body?.cancel();
			setCachedDepotSearch(searchTerm, limit, []);
			return [];
		}

		const payload = await response.json() as { success?: boolean; games?: unknown[] };
		if (!Array.isArray(payload.games)) {
			console.warn("[games-search] depotbox returned an invalid payload");
			setCachedDepotSearch(searchTerm, limit, []);
			return [];
		}

		const items = payload.games
			.map(normalizeDepotboxGame)
			.filter((item): item is SearchItem => Boolean(item))
			.slice(0, limit);

		const validatedItems = await validateDepotboxResultsWithSteam(items);
		setCachedDepotSearch(searchTerm, limit, validatedItems);
		return validatedItems;
	} catch (error) {
		console.warn("[games-search] depotbox request failed:", error instanceof Error ? error.message : "unknown error");
		return [];
	}
}

async function loadFallbackCatalog(): Promise<SearchItem[]> {
	if (gamesCatalogCache.expiresAt > Date.now() && gamesCatalogCache.items.length > 0) {
		return gamesCatalogCache.items;
	}

	const response = await fetchWithTimeout(FALLBACK_GAMES_CATALOG_URL, {
		headers: {
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		},
	}, SEARCH_SOURCE_TIMEOUT_MS);

	if (!response.ok) {
		throw new Error(`Fallback catalog returned HTTP ${response.status}`);
	}

	const payload = await response.json();
	if (!Array.isArray(payload)) {
		throw new Error("Invalid games catalog payload");
	}

	const items = payload
		.map(normalizeFallbackCatalogGame)
		.filter((item): item is SearchItem => Boolean(item));

	gamesCatalogCache = {
		expiresAt: Date.now() + GAMES_CATALOG_CACHE_TTL_MS,
		items,
	};

	return items;
}

async function searchFallbackCatalog(searchTerm: string, limit: number): Promise<SearchItem[]> {
	const normalizedQuery = searchTerm.trim().toLocaleLowerCase();
	if (!normalizedQuery) return [];
	if (hasFreshCatalogMiss(normalizedQuery, limit)) return [];

	const items = await loadFallbackCatalog();
	const topMatches = findTopCatalogMatches(items, normalizedQuery, limit);
	const enrichedItems = await enrichWithSteamMetadata(topMatches);

	if (enrichedItems.length === 0) {
		recordCatalogMiss(normalizedQuery, limit);
	} else {
		clearCatalogMiss(normalizedQuery, limit);
	}

	return enrichedItems;
}

export class GamesSearchRoute extends OpenAPIRoute {
	schema = {
		tags: ["Games"],
		summary: "Search games using the catalog first and Depotbox as a filtered fallback",
		security: [{ bearerAuth: [] }],
		request: {
			body: {
				content: {
					"application/json": {
						schema: GameSearchRequest,
						example: {
							searchTerm: "Cyberpunk",
							limit: 4,
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Returns normalized game search results",
				content: {
					"application/json": {
						schema: GameSearchResponse,
					},
				},
			},
			"401": {
				description: "Missing, invalid or expired access token",
			},
			"502": {
				description: "Could not load search results from any source",
			},
		},
	};

	async handle(c: AppContext) {
		await requireActiveViewerLicense(c);
		const data = await this.getValidatedData<typeof this.schema>();
		const searchTerm = data.body.searchTerm.trim();
		const limit = data.body.limit;
		const env = c.env as Env & GameSearchEnv;

		try {
			const catalogItems = await searchFallbackCatalog(searchTerm, limit);
			if (catalogItems.length > 0) {
				return c.json({
					success: true,
					source: "catalog",
					items: catalogItems,
				}, 200);
			}
		} catch (error) {
			console.warn("[games-search] fallback catalog request failed:", error instanceof Error ? error.message : "unknown error");
		}

		const depotboxItems = await searchDepotbox(env, searchTerm, limit);
		if (depotboxItems.length > 0) {
			return c.json({
				success: true,
				source: "depotbox",
				items: depotboxItems,
			}, 200);
		}

		return c.json({
			success: true,
			source: "depotbox",
			items: [],
		}, 200);
	}
}
