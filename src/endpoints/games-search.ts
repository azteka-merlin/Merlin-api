import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { requireLauncherLicense } from "../lib/launcher-auth";
import { type AppContext, GameSearchRequest, GameSearchResponse } from "../types";

type GameSearchEnv = {
	DEPOTBOX_API_KEY?: string;
	JWT_SECRET?: string;
};

type DepotboxGame = {
	appid?: string | number;
	name?: string;
	is_dlc?: boolean;
	header_image_url?: string | null;
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

type SearchSourceResult = {
	ok: boolean;
	items: SearchItem[];
};

type GamesCatalogRow = {
	app_id: string;
	name: string;
	cover_url: string | null;
	cover_source: string | null;
};

type GamesCatalogUpsertItem = SearchItem & {
	catalogSource: string;
};

const USER_AGENT = "Merlin/2.0";
const DEPOTBOX_SEARCH_URL = "https://depotbox.org/api/search-games";
const RYUU_IMAGE_URL_TEMPLATE = "https://generator.ryuu.lol/files/images/{appid}.jpg";
const GAMES_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const STEAM_NO_IMAGE_CACHE_TTL_MS = 60 * 1000;
const IMAGE_VALIDATION_CACHE_TTL_MS = 30 * 60 * 1000;
const IMAGE_VALIDATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_INVALID_APP_TYPE = "__invalid__";
const SEARCH_SOURCE_TIMEOUT_MS = 3_000;
const STEAM_SEARCH_TIMEOUT_MS = 2_500;
const IMAGE_VALIDATION_TIMEOUT_MS = 1_500;
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

let steamDetailsCache = new Map<string, {
	expiresAt: number;
	type: string | null;
	name: string | null;
	shortDescription: string | null;
	coverUrl: string | null;
	coverSource: string | null;
}>();

let imageValidationCache = new Map<string, {
	expiresAt: number;
	ok: boolean;
}>();

let depotSearchCache = new Map<string, {
	expiresAt: number;
	items: SearchItem[];
}>();

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

function normalizeGameSearchText(value: string): string {
	return String(value || "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLocaleLowerCase();
}

function normalizeFtsQuery(value: string): string {
	const tokens = normalizeGameSearchText(value)
		.split(" ")
		.map((token) => token.trim())
		.filter(Boolean)
		.slice(0, 6);

	return tokens.map((token) => `${token}*`).join(" ");
}

function mapGamesCatalogRow(row: GamesCatalogRow): SearchItem | null {
	const appId = String(row.app_id || "").trim();
	const name = typeof row.name === "string" ? row.name.trim() : "";
	const coverUrl = typeof row.cover_url === "string" ? row.cover_url.trim() : "";
	const coverSource = typeof row.cover_source === "string" ? row.cover_source.trim() : "";

	if (!/^\d+$/.test(appId) || !name) return null;

	return {
		appId,
		name,
		coverUrl: coverUrl || null,
		coverSource: coverSource || null,
	};
}

function getRyuuImageUrl(appId: string): string | null {
	const normalizedAppId = String(appId || "").trim();
	return /^\d+$/.test(normalizedAppId)
		? RYUU_IMAGE_URL_TEMPLATE.replace("{appid}", normalizedAppId)
		: null;
}

function withFallbackCover(item: SearchItem): SearchItem {
	if (item.coverUrl) {
		return item;
	}

	const fallbackCoverUrl = getRyuuImageUrl(item.appId);
	if (!fallbackCoverUrl) {
		return item;
	}

	return {
		...item,
		coverUrl: fallbackCoverUrl,
		coverSource: "ryuu_search_image",
	};
}

async function isImageUrlAvailable(url: string): Promise<boolean> {
	const normalizedUrl = String(url || "").trim();
	if (!normalizedUrl) return false;

	const cached = imageValidationCache.get(normalizedUrl);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.ok;
	}
	imageValidationCache.delete(normalizedUrl);

	try {
		let response = await fetchWithTimeout(normalizedUrl, {
			method: "HEAD",
			headers: {
				Accept: "image/*,*/*;q=0.8",
				"User-Agent": USER_AGENT,
			},
		}, IMAGE_VALIDATION_TIMEOUT_MS);

		if (response.status === 405 || response.status === 403) {
			await response.body?.cancel();
			response = await fetchWithTimeout(normalizedUrl, {
				method: "GET",
				headers: {
					Accept: "image/*,*/*;q=0.8",
					Range: "bytes=0-0",
					"User-Agent": USER_AGENT,
				},
			}, IMAGE_VALIDATION_TIMEOUT_MS);
		}

		const contentType = response.headers.get("content-type") || "";
		const ok = response.ok && (!contentType || contentType.toLocaleLowerCase().startsWith("image/"));
		await response.body?.cancel();
		imageValidationCache.set(normalizedUrl, {
			expiresAt: Date.now() + (ok ? IMAGE_VALIDATION_CACHE_TTL_MS : IMAGE_VALIDATION_FAILURE_TTL_MS),
			ok,
		});
		return ok;
	} catch {
		imageValidationCache.set(normalizedUrl, {
			expiresAt: Date.now() + IMAGE_VALIDATION_FAILURE_TTL_MS,
			ok: false,
		});
		return false;
	}
}

function shouldValidateCatalogCover(item: SearchItem): boolean {
	if (!item.coverUrl) return false;
	const source = String(item.coverSource || "").trim();
	return source !== "steam_capsule_image"
		&& source !== "steam_header_image";
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

async function finalizeCatalogItems(items: SearchItem[]): Promise<SearchItem[]> {
	if (items.length === 0) {
		return items;
	}

	const now = Date.now();
	const catalogCoverResults = await Promise.all(
		items.map(async (item) => {
			if (!shouldValidateCatalogCover(item)) {
				return { appId: item.appId, ok: Boolean(item.coverUrl) };
			}

			return {
				appId: item.appId,
				ok: await isImageUrlAvailable(item.coverUrl || ""),
			};
		})
	);
	const catalogCoverStatus = new Map(catalogCoverResults.map((result) => [result.appId, result.ok]));
	const appIdsToFetch = [...new Set(
		items
			.filter((item) => !item.coverUrl || (shouldValidateCatalogCover(item) && catalogCoverStatus.get(item.appId) === false))
			.map((item) => item.appId)
			.filter((appId) => {
				const cached = steamDetailsCache.get(appId);
				return !cached || cached.expiresAt <= now || !cached.coverUrl;
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
						type: hasBasicData && typeof details.data?.type === "string"
							? details.data.type.trim().toLocaleLowerCase()
							: null,
						name: hasBasicData && typeof details.data?.name === "string"
							? details.data.name.trim()
							: null,
						shortDescription: hasBasicData && typeof details.data?.short_description === "string"
							? details.data.short_description.trim()
							: null,
						coverUrl,
						coverSource,
					});
				}
			} else {
				console.warn(`[games-search] steam image lookup returned HTTP ${response.status}`);
				await response.body?.cancel();
			}
		} catch (error) {
			console.warn("[games-search] steam image lookup failed:", error instanceof Error ? error.message : "unknown error");
		}
	}

	return items.map((item) => {
		const cached = steamDetailsCache.get(item.appId);
		if (item.coverUrl && (!shouldValidateCatalogCover(item) || catalogCoverStatus.get(item.appId) !== false)) {
			return item;
		}

		if (cached?.coverUrl) {
			return {
				...item,
				coverUrl: cached.coverUrl,
				coverSource: cached.coverSource,
			};
		}

		return withFallbackCover(item);
	});
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

			if (sourceCoverUrl) {
				return {
					...item,
					name: cached?.name || item.name,
					coverUrl: sourceCoverUrl,
					coverSource: item.coverSource || null,
				};
			}

			return withFallbackCover({
				...item,
				name: cached?.name || item.name,
				coverUrl: null,
				coverSource: null,
			});
		})
	);
}

async function searchDepotbox(env: GameSearchEnv, searchTerm: string, limit: number): Promise<SearchSourceResult> {
	if (!env.DEPOTBOX_API_KEY) {
		console.warn("[games-search] depotbox api key is not configured");
		return { ok: false, items: [] };
	}

	const cached = getCachedDepotSearch(searchTerm, limit);
	if (cached) {
		return { ok: true, items: cached };
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
				filter_availability: true,
			}),
		}, SEARCH_SOURCE_TIMEOUT_MS);

		if (!response.ok) {
			console.warn(`[games-search] depotbox returned HTTP ${response.status}`);
			await response.body?.cancel();
			return { ok: false, items: [] };
		}

		const payload = await response.json() as { success?: boolean; games?: unknown[] };
		if (payload.success === false || !Array.isArray(payload.games)) {
			console.warn("[games-search] depotbox returned an invalid payload");
			return { ok: false, items: [] };
		}

		const items = payload.games
			.map(normalizeDepotboxGame)
			.filter((item): item is SearchItem => Boolean(item))
			.slice(0, limit);

		const validatedItems = await validateDepotboxResultsWithSteam(items);
		setCachedDepotSearch(searchTerm, limit, validatedItems);
		return { ok: true, items: validatedItems };
	} catch (error) {
		console.warn("[games-search] depotbox request failed:", error instanceof Error ? error.message : "unknown error");
		return { ok: false, items: [] };
	}
}

async function searchD1Catalog(c: AppContext, searchTerm: string, limit: number): Promise<SearchItem[]> {
	const query = searchTerm.trim();
	const safeLimit = Math.max(1, Math.trunc(Number(limit) || 0));
	if (!query) return [];

	const rows: GamesCatalogRow[] = [];

	if (/^\d+$/.test(query)) {
		const exact = await c.env.merlin_db
			.prepare(
				`
					SELECT app_id, name, cover_url, cover_source
					FROM games_catalog
					WHERE app_id = ?
					LIMIT 1
				`,
			)
			.bind(query)
			.all<GamesCatalogRow>();

		rows.push(...(exact.results || []));
		if (rows.length >= safeLimit) {
			return finalizeCatalogItems(rows.map(mapGamesCatalogRow).filter((item): item is SearchItem => Boolean(item)));
		}
	}

	const ftsQuery = normalizeFtsQuery(query);
	if (!ftsQuery) return [];

	const result = await c.env.merlin_db
		.prepare(
			`
				SELECT g.app_id, g.name, g.cover_url, g.cover_source
				FROM games_catalog_fts f
				JOIN games_catalog g ON g.rowid = f.rowid
				WHERE games_catalog_fts MATCH ?
				ORDER BY bm25(games_catalog_fts)
				LIMIT ?
			`,
		)
		.bind(ftsQuery, safeLimit)
		.all<GamesCatalogRow>();

	const seen = new Set(rows.map((row) => row.app_id));
	for (const row of result.results || []) {
		if (seen.has(row.app_id)) continue;
		seen.add(row.app_id);
		rows.push(row);
	}

	return finalizeCatalogItems(rows
		.slice(0, safeLimit)
		.map(mapGamesCatalogRow)
		.filter((item): item is SearchItem => Boolean(item)));
}

async function upsertGamesCatalogItems(c: AppContext, items: GamesCatalogUpsertItem[]): Promise<void> {
	if (items.length === 0) return;

	const now = new Date().toISOString();
	const uniqueItems = new Map<string, GamesCatalogUpsertItem>();
	for (const item of items) {
		if (!/^\d+$/.test(item.appId) || !item.name.trim()) continue;
		uniqueItems.set(item.appId, item);
	}

	const statements = [...uniqueItems.values()].map((item) => c.env.merlin_db
		.prepare(
			`
				INSERT INTO games_catalog (
					app_id,
					name,
					type,
					cover_url,
					cover_source,
					tags_json,
					nsfw,
					drm,
					added_at,
					updated_at,
					catalog_source,
					catalog_synced_at
				)
				VALUES (?, ?, 'game', ?, ?, '[]', 0, 0, NULL, NULL, ?, ?)
				ON CONFLICT(app_id) DO UPDATE SET
					name = excluded.name,
					cover_url = COALESCE(excluded.cover_url, games_catalog.cover_url),
					cover_source = COALESCE(excluded.cover_source, games_catalog.cover_source),
					catalog_source = excluded.catalog_source,
					catalog_synced_at = excluded.catalog_synced_at
			`,
		)
		.bind(
			item.appId,
			item.name.trim(),
			item.coverUrl || null,
			item.coverSource || null,
			item.catalogSource,
			now,
		));

	await c.env.merlin_db.batch(statements);
}

export class GamesSearchRoute extends OpenAPIRoute {
	schema = {
		tags: ["Games"],
		summary: "Search games using the D1 catalog first and Depotbox as a fallback",
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
		await requireLauncherLicense(c);
		const data = await this.getValidatedData<typeof this.schema>();
		const searchTerm = data.body.searchTerm.trim();
		const limit = data.body.limit;
		const env = c.env as Env & GameSearchEnv;

		try {
			const d1CatalogItems = await searchD1Catalog(c, searchTerm, limit);
			if (d1CatalogItems.length > 0) {
				c.executionCtx.waitUntil(upsertGamesCatalogItems(c, d1CatalogItems.map((item) => ({
					...item,
					catalogSource: "catalog",
				}))).catch((error) => {
					console.warn("[games-search] D1 catalog refresh failed:", error instanceof Error ? error.message : "unknown error");
				}));

				return c.json({
					success: true,
					source: "catalog",
					items: d1CatalogItems,
				}, 200);
			}
		} catch (error) {
			console.warn("[games-search] D1 catalog search failed:", error instanceof Error ? error.message : "unknown error");
		}

		const depotboxResult = await searchDepotbox(env, searchTerm, limit);
		if (depotboxResult.ok) {
			c.executionCtx.waitUntil(upsertGamesCatalogItems(c, depotboxResult.items.map((item) => ({
				...item,
				catalogSource: "depotbox",
			}))).catch((error) => {
				console.warn("[games-search] D1 catalog upsert failed:", error instanceof Error ? error.message : "unknown error");
			}));

			return c.json({
				success: true,
				source: "depotbox",
				items: depotboxResult.items,
			}, 200);
		}

		return c.json({
			success: true,
			source: "depotbox",
			items: [],
		}, 200);
	}
}
