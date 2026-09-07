import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppBindings, AppContext } from "../types";
import { searchGamesForCatalog } from "./games-search";
import { readOverrides } from "../lib/overrides";

const CatalogQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.enum(["premium", "standard"]).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
});

type CatalogRow = {
  app_id: string;
  name: string;
  cover_url: string | null;
  category: "premium" | "standard" | "reviewing";
  available_in_merlin: number;
  release_date: string | null;
};

type CatalogSourceGame = {
  appId: string;
  name: string;
  availableFromPremium: boolean;
  availableFromCorrection: boolean;
};

type ExistingCatalogSourceGame = {
  app_id: string;
  name: string | null;
  premium_game_enabled: number;
  eligible_correction: number;
};

type RemoteFix = { href?: string; filename?: string; badges?: unknown[] };
type RemoteCorrection = { appid?: string | number; name?: string; fixes?: RemoteFix[] };

const FIXES_CATALOG_URL = "https://generator.ryuu.lol/files/fixes.json";
const AVAILABILITY_SYNC_TTL_MS = 5 * 60 * 1000;
const AVAILABILITY_SYNC_STATE_KEY = "availability_sources";
const SEARCH_CANDIDATE_LIMIT = 12;
const NON_CATALOG_GAME_NAME_PATTERN = /\b(?:demo|playtest|beta|test server)\b/i;
let availabilitySyncedAt = 0;
let availabilitySync: Promise<void> | null = null;

function normalizedName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isCatalogGameName(value: string): boolean {
  return !NON_CATALOG_GAME_NAME_PATTERN.test(value);
}

function catalogRowPriority(row: CatalogRow): number {
  if (row.available_in_merlin) return 0;
  if (row.category === "premium") return 1;
  if (row.category === "standard") return 2;
  return 3;
}

function dedupeCatalogRows(rows: CatalogRow[], limit: number): CatalogRow[] {
  const gamesByTitle = new Map<string, CatalogRow>();
  for (const row of rows) {
    if (!isCatalogGameName(row.name)) continue;
    const key = normalizedName(row.name);
    const current = gamesByTitle.get(key);
    if (!current || catalogRowPriority(row) < catalogRowPriority(current)) gamesByTitle.set(key, row);
  }
  return [...gamesByTitle.values()].slice(0, limit);
}

function hasEligibleCorrection(fixes: unknown): boolean {
  if (!Array.isArray(fixes)) return false;
  return fixes.some((fix) => {
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) return false;
    const candidate = fix as RemoteFix;
    const badges = Array.isArray(candidate.badges)
      ? candidate.badges.map((value) => String(value || "").trim().toLocaleLowerCase())
      : [];
    return Boolean(String(candidate.href || "").trim() && String(candidate.filename || "").trim() && !badges.includes("hypervisor"));
  });
}

function batch<T>(items: T[], size = 100): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function availabilitySourceHash(games: Iterable<CatalogSourceGame>): Promise<string> {
  const source = JSON.stringify([...games]
    .sort((left, right) => left.appId.localeCompare(right.appId))
    .map((game) => [game.appId, game.name, Number(game.availableFromPremium), Number(game.availableFromCorrection)]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function runCatalogAvailabilitySync(env: Pick<AppBindings, "merlin_db" | "MERLIN_FILES">): Promise<void> {
  if (availabilitySync) return availabilitySync;
  if (availabilitySyncedAt + AVAILABILITY_SYNC_TTL_MS > Date.now()) return;

  availabilitySync = (async () => {
    const now = new Date().toISOString();
    const [premiumResult, remoteResult, overrides] = await Promise.all([
      env.merlin_db.prepare("SELECT app_id, name FROM premium_games WHERE enabled = 1").all<{ app_id: string; name: string }>(),
      fetch(FIXES_CATALOG_URL, { headers: { Accept: "application/json", "User-Agent": "Merlin/2.0" } }),
      readOverrides(env),
    ]);
    if (!remoteResult.ok) {
      console.warn(`[public-catalog] availability source returned HTTP ${remoteResult.status}`);
      return;
    }

    const games = new Map<string, CatalogSourceGame>();
    for (const premium of premiumResult.results || []) {
      games.set(premium.app_id, { appId: premium.app_id, name: premium.name, availableFromPremium: true, availableFromCorrection: false });
    }

    const entries = await remoteResult.json() as unknown;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const correction = entry as RemoteCorrection;
        const appId = String(correction.appid || "").trim();
        const name = String(correction.name || "").trim();
        if (!/^\d+$/.test(appId) || !name || !hasEligibleCorrection(correction.fixes)) continue;
        const override = overrides[appId];
        if (override?.hidden === true || override?.fixOverride?.enabled === false) continue;
        const existing = games.get(appId);
        games.set(appId, { appId, name: override?.name || existing?.name || name, availableFromPremium: existing?.availableFromPremium || false, availableFromCorrection: true });
      }
    }

    for (const [appId, override] of Object.entries(overrides)) {
      if (override.hidden || !override.fixOverride?.enabled || !override.name) continue;
      const existing = games.get(appId);
      games.set(appId, { appId, name: override.name, availableFromPremium: existing?.availableFromPremium || false, availableFromCorrection: true });
    }

    const sourceGames = [...games.values()];
    const sourceHash = await availabilitySourceHash(sourceGames);
    const previous = await env.merlin_db.prepare("SELECT source_hash FROM catalog_sync_state WHERE sync_key = ?")
      .bind(AVAILABILITY_SYNC_STATE_KEY)
      .first<{ source_hash: string }>();
    if (previous?.source_hash === sourceHash) {
      availabilitySyncedAt = Date.now();
      return;
    }

    const existingSources = await env.merlin_db.prepare(`
      SELECT a.app_id, g.name, a.premium_game_enabled, a.eligible_correction
      FROM catalog_availability a
      LEFT JOIN catalog_games g ON g.app_id = a.app_id
      WHERE a.premium_game_enabled = 1 OR a.eligible_correction = 1
    `).all<ExistingCatalogSourceGame>();
    const existingByAppId = new Map((existingSources.results || []).map((game) => [game.app_id, game]));
    const currentByAppId = new Map(sourceGames.map((game) => [game.appId, game]));
    const changedGames = sourceGames.filter((game) => {
      const existing = existingByAppId.get(game.appId);
      return !existing
        || existing.name !== game.name
        || Boolean(existing.premium_game_enabled) !== game.availableFromPremium
        || Boolean(existing.eligible_correction) !== game.availableFromCorrection;
    });
    const removedAppIds = [...existingByAppId.keys()].filter((appId) => !currentByAppId.has(appId));

    for (const appIdBatch of batch(removedAppIds)) {
      const placeholders = appIdBatch.map(() => "?").join(", ");
      await env.merlin_db.prepare(`
        UPDATE catalog_availability
        SET premium_game_enabled = 0,
          eligible_correction = 0,
          available_in_merlin = 0,
          checked_at = ?
        WHERE app_id IN (${placeholders})
      `).bind(now, ...appIdBatch).run();
    }

    for (const sourceGameBatch of batch(changedGames)) {
      await env.merlin_db.batch(sourceGameBatch.flatMap((game) => [
        env.merlin_db.prepare(`
          INSERT INTO catalog_games (app_id, name, normalized_name, cover_url, discovered_from, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, NULL, 'merlin_catalog', ?, ?)
          ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at
        `).bind(game.appId, game.name, normalizedName(game.name), now, now),
        env.merlin_db.prepare("INSERT INTO catalog_game_metadata (app_id, category, denuvo, drm_source, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET category = CASE WHEN excluded.drm_source = 'premium_registry' THEN 'premium' ELSE catalog_game_metadata.category END, denuvo = CASE WHEN excluded.drm_source = 'premium_registry' THEN 1 ELSE catalog_game_metadata.denuvo END, drm_source = CASE WHEN excluded.drm_source = 'premium_registry' THEN 'premium_registry' ELSE catalog_game_metadata.drm_source END, checked_at = excluded.checked_at").bind(game.appId, game.availableFromPremium ? "premium" : "reviewing", game.availableFromPremium ? 1 : null, game.availableFromPremium ? "premium_registry" : null, now),
        env.merlin_db.prepare("INSERT INTO catalog_availability (app_id, available_in_merlin, premium_game_enabled, eligible_correction, checked_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET available_in_merlin = 1, premium_game_enabled = excluded.premium_game_enabled, eligible_correction = excluded.eligible_correction, checked_at = excluded.checked_at").bind(game.appId, Number(game.availableFromPremium), Number(game.availableFromCorrection), now),
        env.merlin_db.prepare("INSERT INTO catalog_enrichment_jobs (app_id, status, next_attempt_at, updated_at) SELECT ?, 'pending', ?, ? WHERE NOT EXISTS (SELECT 1 FROM catalog_game_metadata WHERE app_id = ? AND release_date IS NOT NULL) ON CONFLICT(app_id) DO NOTHING").bind(game.appId, now, now, game.appId),
      ]));
    }
    await env.merlin_db.prepare(`
      INSERT INTO catalog_sync_state (sync_key, source_hash, synced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET source_hash = excluded.source_hash, synced_at = excluded.synced_at
    `).bind(AVAILABILITY_SYNC_STATE_KEY, sourceHash, now).run();
    availabilitySyncedAt = Date.now();
  })().catch((error) => {
    console.warn("[public-catalog] availability sync failed:", error instanceof Error ? error.message : "unknown error");
  }).finally(() => {
    availabilitySync = null;
  });

  return availabilitySync;
}

async function upsertCatalogGames(c: AppContext, games: Array<{ appId: string; name: string; coverUrl: string | null }>) {
  const now = new Date().toISOString();
  await c.env.merlin_db.batch(games.map((game) => c.env.merlin_db.prepare(`
    INSERT INTO catalog_games (app_id, name, normalized_name, cover_url, discovered_from, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'search_engine', ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, cover_url = COALESCE(excluded.cover_url, catalog_games.cover_url), last_seen_at = excluded.last_seen_at
    WHERE catalog_games.name IS NOT excluded.name
      OR (excluded.cover_url IS NOT NULL AND catalog_games.cover_url IS NOT excluded.cover_url)
  `).bind(game.appId, game.name, normalizedName(game.name), game.coverUrl, now, now)));
  await c.env.merlin_db.batch(games.flatMap((game) => [
    c.env.merlin_db.prepare("INSERT INTO catalog_game_metadata (app_id) VALUES (?) ON CONFLICT(app_id) DO NOTHING").bind(game.appId),
    c.env.merlin_db.prepare("INSERT INTO catalog_availability (app_id, available_in_merlin, premium_game_enabled, eligible_correction, checked_at) VALUES (?, 0, 0, 0, ?) ON CONFLICT(app_id) DO UPDATE SET available_in_merlin = CASE WHEN premium_game_enabled = 1 OR eligible_correction = 1 THEN 1 ELSE 0 END, checked_at = excluded.checked_at WHERE available_in_merlin IS NOT CASE WHEN premium_game_enabled = 1 OR eligible_correction = 1 THEN 1 ELSE 0 END").bind(game.appId, now),
    c.env.merlin_db.prepare("INSERT INTO catalog_enrichment_jobs (app_id, status, next_attempt_at, updated_at) VALUES (?, 'pending', ?, ?) ON CONFLICT(app_id) DO NOTHING").bind(game.appId, now, now),
  ]));
}

async function searchIsolatedCatalog(c: AppContext, search: string, category?: "premium" | "standard"): Promise<CatalogRow[]> {
  const tokens = normalizedName(search).split(" ").filter(Boolean).slice(0, 6);
  if (!tokens.length) return [];
  const filters = tokens.map(() => "g.normalized_name LIKE ?");
  const values: Array<string> = tokens.map((token) => `%${token}%`);
  if (category) {
    filters.push("COALESCE(m.category, 'reviewing') = ?");
    values.push(category);
  }
  const rows = await c.env.merlin_db.prepare(`
    SELECT g.app_id, g.name, g.cover_url,
      COALESCE(m.category, 'reviewing') AS category,
      COALESCE(a.available_in_merlin, 0) AS available_in_merlin,
      m.release_date
    FROM catalog_games g
    LEFT JOIN catalog_game_metadata m ON m.app_id = g.app_id
    LEFT JOIN catalog_availability a ON a.app_id = g.app_id
    WHERE ${filters.join(" AND ")}
    ORDER BY COALESCE(a.available_in_merlin, 0) DESC,
      CASE WHEN g.normalized_name = ? THEN 0 ELSE 1 END,
      m.release_date IS NULL ASC, m.release_date DESC, g.name COLLATE NOCASE ASC
    LIMIT ?
  `).bind(...values, normalizedName(search), SEARCH_CANDIDATE_LIMIT).all<CatalogRow>();
  return dedupeCatalogRows(rows.results || [], 3);
}

export class PublicCatalogRoute extends OpenAPIRoute {
  schema = {
    tags: ["Public"],
    summary: "List the public Merlin game catalog",
    request: { query: CatalogQuery },
  };

  async handle(c: AppContext) {
    const { query } = await this.getValidatedData<typeof this.schema>();
    const search = (query.q || "").trim();
    if (search && search.length < 5) {
      return c.json({ success: true, games: [], hasMore: false }, 200);
    }

    const filters = ["1 = 1"];
    const values: Array<string | number> = [];
    if (query.category) {
      filters.push("COALESCE(m.category, 'reviewing') = ?");
      values.push(query.category);
    }
    const limit = search ? 3 : 24;
    let items: CatalogRow[] = [];
    if (!search) {
      const titleRankOrder = `m.release_date IS NULL ASC, m.release_date DESC, COALESCE(a.available_in_merlin, 0) DESC`;
      const catalogOrder = `release_date IS NULL ASC, release_date DESC, available_in_merlin DESC`;
      const rows = await c.env.merlin_db.prepare(`
      WITH ranked_catalog AS (
        SELECT g.app_id, g.name, g.cover_url,
          COALESCE(m.category, 'reviewing') AS category,
          COALESCE(a.available_in_merlin, 0) AS available_in_merlin,
          m.release_date,
          ROW_NUMBER() OVER (
            PARTITION BY g.normalized_name
            ORDER BY ${titleRankOrder},
              CASE COALESCE(m.category, 'reviewing') WHEN 'premium' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END,
              g.app_id ASC
          ) AS title_rank
        FROM catalog_games g
        LEFT JOIN catalog_game_metadata m ON m.app_id = g.app_id
        LEFT JOIN catalog_availability a ON a.app_id = g.app_id
        WHERE ${filters.join(" AND ")}
          AND lower(g.name) NOT LIKE '% demo%'
          AND lower(g.name) NOT LIKE '% playtest%'
          AND lower(g.name) NOT LIKE '% beta%'
          AND lower(g.name) NOT LIKE '%test server%'
      )
      SELECT app_id, name, cover_url, category, available_in_merlin, release_date
      FROM ranked_catalog
      WHERE title_rank = 1
      ORDER BY ${catalogOrder},
        CASE category WHEN 'premium' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END,
        name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
      `).bind(...values, limit + 1, (query.page - 1) * limit).all<CatalogRow>();
      items = rows.results || [];
    } else {
      const isolated = await searchIsolatedCatalog(c, search, query.category);
      const discovered = await searchGamesForCatalog(c, search, SEARCH_CANDIDATE_LIMIT);
      if (discovered.length) {
        await upsertCatalogGames(c, discovered);
        const orderedAppIds = [...new Set([...isolated.map((game) => game.app_id), ...discovered.map((game) => game.appId)])];
        const placeholders = orderedAppIds.map(() => "?").join(", ");
        const found = (await c.env.merlin_db.prepare(`
          SELECT g.app_id, g.name, g.cover_url, COALESCE(m.category, 'reviewing') AS category, COALESCE(a.available_in_merlin, 0) AS available_in_merlin, m.release_date
          FROM catalog_games g LEFT JOIN catalog_game_metadata m ON m.app_id = g.app_id LEFT JOIN catalog_availability a ON a.app_id = g.app_id
          WHERE g.app_id IN (${placeholders})${query.category ? " AND COALESCE(m.category, 'reviewing') = ?" : ""}
        `).bind(...orderedAppIds, ...(query.category ? [query.category] : [])).all<CatalogRow>()).results || [];
        const byAppId = new Map(found.map((game) => [game.app_id, game]));
        items = dedupeCatalogRows(orderedAppIds.map((appId) => byAppId.get(appId)).filter((game): game is CatalogRow => Boolean(game)), limit);
      } else {
        items = isolated;
      }
    }
    return c.json({
      success: true,
      games: items.slice(0, limit).map((game) => ({
        appId: game.app_id,
        name: game.name,
        coverUrl: game.cover_url || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(game.app_id)}/header.jpg`,
        fallbackCoverUrls: [
          `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(game.app_id)}/header.jpg`,
          `https://generator.ryuu.lol/files/images/${encodeURIComponent(game.app_id)}.jpg`,
        ].filter((url, index, urls) => urls.indexOf(url) === index && url !== game.cover_url),
        category: game.category,
        availableInMerlin: game.category === "standard" || Boolean(game.available_in_merlin),
      })),
      hasMore: !search && items.length > limit,
    }, 200);
  }
}
