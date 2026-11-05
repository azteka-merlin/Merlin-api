const RECHECK_MS = 5 * 60_000;

// 06:00 UTC is after midnight in both EST and EDT. If quota is still
// exhausted after that, keep checking periodically until the API permits it.
export function nextHubcapQuotaCheck(now: number, reopening = false): number {
  const current = new Date(now);
  const reset = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), 6);
  if (now < reset) return reset;
  if (reopening) return now + RECHECK_MS;
  return reset + 24 * 60 * 60_000;
}
const STATS_URL = "https://hubcapmanifest.com/api/v1/user/stats";

// The stored fingerprint keeps quota state isolated if the API key is rotated.
async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hubcapQuotaAllows(db: D1Database, token: string): Promise<boolean> {
  try {
    const key = await fingerprint(token);
    const now = Date.now();
    const row = await db.prepare("SELECT retry_after FROM hubcap_quota_circuit WHERE key_hash = ?")
      .bind(key).first<{ retry_after: number }>();
    if (row && row.retry_after > now) {
      console.info({ event: "manifest_source_skipped", source: "hubcap", reason: "quota_circuit_open", retryAfter: row.retry_after });
      return false;
    }
    const response = await fetch(STATS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`stats HTTP ${response.status}`); }
    const stats = await response.json() as { daily_usage?: unknown; daily_limit?: unknown; can_make_requests?: unknown };
    if (typeof stats.daily_usage !== "number" || typeof stats.daily_limit !== "number"
      || !Number.isFinite(stats.daily_usage) || !Number.isFinite(stats.daily_limit)
      || stats.daily_usage < 0 || stats.daily_limit < 0 || typeof stats.can_make_requests !== "boolean") {
      throw new Error("invalid usage response");
    }
    if (!stats.can_make_requests || stats.daily_usage >= stats.daily_limit) {
      const retryAfter = nextHubcapQuotaCheck(now, Boolean(row));
      await db.prepare(`INSERT INTO hubcap_quota_circuit (key_hash, retry_after) VALUES (?, ?)
        ON CONFLICT(key_hash) DO UPDATE SET retry_after = excluded.retry_after`).bind(key, retryAfter).run();
      console.info({ event: "manifest_source_skipped", source: "hubcap", reason: "quota_exhausted", dailyUsage: stats.daily_usage, dailyLimit: stats.daily_limit, retryAfter });
      return false;
    }
    if (row) await db.prepare("DELETE FROM hubcap_quota_circuit WHERE key_hash = ?").bind(key).run();
    console.info({ event: "manifest_source_quota", source: "hubcap", dailyUsage: stats.daily_usage, dailyLimit: stats.daily_limit });
    return true;
  } catch (error) {
    console.warn({ event: "manifest_source_skipped", source: "hubcap", reason: "quota_check_failed", detail: error instanceof Error ? error.message : "unknown" });
    return false;
  }
}

// A circuit remains open until a successful usage check clears it, even after
// retry_after has passed and the next request is eligible to probe it.
export async function getHubcapCircuitStatus(db: D1Database, token: string | undefined) {
  if (!token?.trim()) return { status: "unconfigured" as const, retryAfter: null };
  const key = await fingerprint(token.trim());
  const row = await db.prepare("SELECT retry_after FROM hubcap_quota_circuit WHERE key_hash = ?")
    .bind(key).first<{ retry_after: number }>();
  return row
    ? { status: "open" as const, retryAfter: new Date(row.retry_after).toISOString() }
    : { status: "closed" as const, retryAfter: null };
}
