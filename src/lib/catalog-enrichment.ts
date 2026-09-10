import type { AppBindings } from "../types";

type Job = { app_id: string; attempts: number };
type SteamAppDetails = {
  success?: boolean;
  data?: {
    drm_notice?: string;
    release_date?: { coming_soon?: boolean; date?: string };
  };
};
export type DenuvoResolution = {
  appId: string;
  category: "premium" | "standard";
  denuvo: 0 | 1;
  drmNotice: string | null;
  releaseDate: string | null;
};

const STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const JOB_BATCH_SIZE = 25;
const STEAM_REQUEST_INTERVAL_MS = 1_000;
const DENUVO_REFRESH_LIMIT = 30;
const RETRY_DELAY_MS = 15 * 60_000;
const RELEASE_DATE_RETRY_DELAY_MS = 24 * 60 * 60_000;
let nextSteamRequestAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function steamReleaseDate(value: unknown, comingSoon: unknown): string | null {
  if (comingSoon === true || typeof value !== "string" || !value.trim()) return null;
  // Steam's English payload uses values such as "3 Sep, 2026", which Date.parse
  // does not consistently accept until the presentation comma is removed.
  const timestamp = Date.parse(value.replace(/,/g, ""));
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10);
}

async function fetchSteamApp(appId: string): Promise<DenuvoResolution | null> {
  const waitMs = Math.max(0, nextSteamRequestAt - Date.now());
  nextSteamRequestAt = Math.max(nextSteamRequestAt, Date.now()) + STEAM_REQUEST_INTERVAL_MS;
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

  const url = new URL(STEAM_APPDETAILS_URL);
  url.searchParams.set("appids", appId);
  url.searchParams.set("l", "english");
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Merlin/2.0" },
  });
  if (!response.ok) throw new Error(`steam returned HTTP ${response.status}`);

  const payload = await response.json() as Record<string, SteamAppDetails>;
  const details = payload[appId];
  if (!details?.success) return null;
  const drmNotice = String(details.data?.drm_notice || "").trim();
  const denuvo = /denuvo/i.test(drmNotice) ? 1 : 0;
  return {
    appId,
    category: denuvo ? "premium" : "standard",
    denuvo,
    drmNotice: drmNotice || null,
    releaseDate: steamReleaseDate(details.data?.release_date?.date, details.data?.release_date?.coming_soon),
  };
}

async function saveResolutions(env: Pick<AppBindings, "merlin_db">, resolutions: DenuvoResolution[], completeJobs: boolean) {
  if (!resolutions.length) return;
  const now = nowIso();
  const releaseDateRetryAt = new Date(Date.now() + RELEASE_DATE_RETRY_DELAY_MS).toISOString();
  await env.merlin_db.batch(resolutions.flatMap((result) => [
    env.merlin_db.prepare(`
      UPDATE catalog_game_metadata
      SET category = CASE WHEN drm_source = 'premium_registry' THEN category ELSE ? END,
        denuvo = CASE WHEN drm_source = 'premium_registry' THEN denuvo ELSE ? END,
        drm_notice = CASE WHEN drm_source = 'premium_registry' THEN drm_notice ELSE ? END,
        drm_source = CASE WHEN drm_source = 'premium_registry' THEN drm_source ELSE 'steam' END,
        release_date = ?, checked_at = ?, expires_at = ?
      WHERE app_id = ? AND (
        release_date IS NOT ?
        OR (drm_source IS NOT 'premium_registry' AND (
          category IS NOT ?
          OR denuvo IS NOT ?
          OR drm_notice IS NOT ?
          OR drm_source IS NOT 'steam'
        ))
      )
    `).bind(result.category, result.denuvo, result.drmNotice, result.releaseDate, now, new Date(Date.now() + (result.denuvo ? 60 * 60_000 : 30 * 86_400_000)).toISOString(), result.appId, result.releaseDate, result.category, result.denuvo, result.drmNotice),
    ...(completeJobs ? [
      env.merlin_db.prepare(`
        UPDATE catalog_enrichment_jobs
        SET status = CASE WHEN ? IS NULL THEN 'retry' ELSE 'completed' END,
          attempts = CASE WHEN ? IS NULL THEN attempts + 1 ELSE attempts END,
          next_attempt_at = CASE WHEN ? IS NULL THEN ? ELSE next_attempt_at END,
          locked_until = NULL,
          updated_at = ?
        WHERE app_id = ?
      `).bind(result.releaseDate, result.releaseDate, result.releaseDate, releaseDateRetryAt, now, result.appId),
    ] : []),
  ]));
}

async function retryJobs(env: Pick<AppBindings, "merlin_db">, jobs: Job[]) {
  if (!jobs.length) return;
  const now = nowIso();
  const retryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  await env.merlin_db.batch(jobs.map((job) => env.merlin_db.prepare(`
    UPDATE catalog_enrichment_jobs
    SET status = 'retry', attempts = ?, next_attempt_at = ?, locked_until = NULL, updated_at = ?
    WHERE app_id = ?
  `).bind(job.attempts + 1, retryAt, now, job.app_id)));
}

export async function resolveDenuvoFromSteam(appIds: string[]): Promise<Map<string, DenuvoResolution>> {
  const uniqueIds = [...new Set(appIds.filter((appId) => /^\d+$/.test(appId)))];
  const results = new Map<string, DenuvoResolution>();
  for (const appId of uniqueIds) {
    try {
      const result = await fetchSteamApp(appId);
      if (result) results.set(result.appId, result);
    } catch (error) {
      console.warn("[catalog-enrichment] Steam request failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
  return results;
}

export async function runCatalogEnrichment(env: Pick<AppBindings, "merlin_db">): Promise<void> {
  const now = nowIso();
  const candidates = await env.merlin_db.prepare(`
    SELECT j.app_id, j.attempts FROM catalog_enrichment_jobs j
    LEFT JOIN catalog_availability a ON a.app_id = j.app_id
    LEFT JOIN catalog_game_metadata m ON m.app_id = j.app_id
    LEFT JOIN premium_games p ON p.app_id = j.app_id AND p.enabled = 1
    WHERE (
      (j.status IN ('pending', 'retry') AND j.next_attempt_at <= ?)
      OR (j.status = 'processing' AND (j.locked_until IS NULL OR j.locked_until <= ?))
    )
    ORDER BY CASE
      WHEN j.status = 'processing' THEN 0
      WHEN m.category IN ('premium', 'standard') AND m.release_date IS NULL THEN 1
      ELSE 2
    END,
      COALESCE(a.available_in_merlin, 0) DESC, p.updated_at DESC, j.next_attempt_at LIMIT ?
  `).bind(now, now, JOB_BATCH_SIZE).all<Job>();

  const lockUntil = new Date(Date.now() + 10 * 60_000).toISOString();
  const locked: Job[] = [];
  for (const job of candidates.results || []) {
    const result = await env.merlin_db.prepare(`
      UPDATE catalog_enrichment_jobs SET status = 'processing', locked_until = ?, updated_at = ?
      WHERE app_id = ? AND (locked_until IS NULL OR locked_until <= ?)
    `).bind(lockUntil, now, job.app_id, now).run();
    if (result.meta.changes) locked.push(job);
  }

  const resolutions = await resolveDenuvoFromSteam(locked.map((job) => job.app_id));
  await saveResolutions(env, [...resolutions.values()], true);
  await retryJobs(env, locked.filter((job) => !resolutions.has(job.app_id)));
}

export async function refreshConfirmedDenuvo(env: Pick<AppBindings, "merlin_db">): Promise<void> {
  const rows = await env.merlin_db.prepare(`
    SELECT app_id FROM catalog_game_metadata
    WHERE denuvo = 1
    ORDER BY COALESCE(checked_at, '') ASC
    LIMIT ?
  `).bind(DENUVO_REFRESH_LIMIT).all<{ app_id: string }>();
  const appIds = (rows.results || []).map((row) => row.app_id);
  if (!appIds.length) return;

  try {
    const resolutions = await resolveDenuvoFromSteam(appIds);
    await saveResolutions(env, [...resolutions.values()], false);
  } catch (error) {
    console.warn("[catalog-enrichment] Denuvo refresh failed:", error instanceof Error ? error.message : "unknown error");
  }
}
