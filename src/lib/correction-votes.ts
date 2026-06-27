export type CorrectionVoteValue = "up" | "down";

type VoteEnv = {
  merlin_db: D1Database;
};

type VoteTotalsRow = {
  app_id: string;
  upvotes: number | string | null;
  downvotes: number | string | null;
};

type ViewerVoteRow = {
  app_id: string;
  vote: CorrectionVoteValue;
};

const MAX_FILTERED_APP_IDS = 150;

function normalizeAppId(appId: string): string {
  const normalized = String(appId || "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Invalid appId");
  }
  return normalized;
}

function toInt(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

export async function upsertCorrectionVote(
  env: VoteEnv,
  input: { appId: string; licenseId: number; hwid?: string | null; vote: CorrectionVoteValue },
) {
  const appId = normalizeAppId(input.appId);
  const now = new Date().toISOString();

  await env.merlin_db
    .prepare(
      `INSERT INTO correction_votes (
        app_id,
        license_id,
        hwid,
        vote,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, license_id) DO UPDATE SET
        hwid = excluded.hwid,
        vote = excluded.vote,
        updated_at = excluded.updated_at`,
    )
    .bind(appId, input.licenseId, input.hwid || null, input.vote, now, now)
    .run();
}

export async function listCorrectionVoteTotals(
  env: VoteEnv,
  appIds?: string[],
): Promise<Map<string, { upvotes: number; downvotes: number; score: number }>> {
  const normalizedAppIds = Array.isArray(appIds)
    ? appIds.map(normalizeAppId)
    : [];

  const filterSet = normalizedAppIds.length > 0 ? new Set(normalizedAppIds) : null;
  const hasFilter = normalizedAppIds.length > 0 && normalizedAppIds.length <= MAX_FILTERED_APP_IDS;
  const placeholders = hasFilter ? normalizedAppIds.map(() => "?").join(", ") : "";
  const query = hasFilter
    ? `SELECT
        app_id,
        SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS upvotes,
        SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS downvotes
      FROM correction_votes
      WHERE app_id IN (${placeholders})
      GROUP BY app_id`
    : `SELECT
        app_id,
        SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS upvotes,
        SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS downvotes
      FROM correction_votes
      GROUP BY app_id`;

  const result = await env.merlin_db
    .prepare(query)
    .bind(...(hasFilter ? normalizedAppIds : []))
    .all<VoteTotalsRow>();

  const map = new Map<string, { upvotes: number; downvotes: number; score: number }>();
  for (const row of result.results || []) {
    const appId = String(row.app_id);
    if (filterSet && !filterSet.has(appId)) continue;
    const upvotes = toInt(row.upvotes);
    const downvotes = toInt(row.downvotes);
    map.set(appId, {
      upvotes,
      downvotes,
      score: upvotes - downvotes,
    });
  }

  return map;
}

export async function getCorrectionVoteTotals(
  env: VoteEnv,
  appId: string,
): Promise<{ upvotes: number; downvotes: number; score: number }> {
  const totals = await listCorrectionVoteTotals(env, [appId]);
  return totals.get(normalizeAppId(appId)) || {
    upvotes: 0,
    downvotes: 0,
    score: 0,
  };
}

export async function listViewerVotes(
  env: VoteEnv,
  licenseId: number,
  appIds?: string[],
): Promise<Map<string, CorrectionVoteValue>> {
  const normalizedAppIds = Array.isArray(appIds)
    ? appIds.map(normalizeAppId)
    : [];

  const filterSet = normalizedAppIds.length > 0 ? new Set(normalizedAppIds) : null;
  const hasFilter = normalizedAppIds.length > 0 && normalizedAppIds.length <= MAX_FILTERED_APP_IDS;
  const placeholders = hasFilter ? normalizedAppIds.map(() => "?").join(", ") : "";
  const query = hasFilter
    ? `SELECT app_id, vote
      FROM correction_votes
      WHERE license_id = ?
        AND app_id IN (${placeholders})`
    : `SELECT app_id, vote
      FROM correction_votes
      WHERE license_id = ?`;

  const bindings = hasFilter ? [licenseId, ...normalizedAppIds] : [licenseId];
  const result = await env.merlin_db
    .prepare(query)
    .bind(...bindings)
    .all<ViewerVoteRow>();

  const map = new Map<string, CorrectionVoteValue>();
  for (const row of result.results || []) {
    const appId = String(row.app_id);
    if (filterSet && !filterSet.has(appId)) continue;
    if (row.vote === "up" || row.vote === "down") {
      map.set(appId, row.vote);
    }
  }

  return map;
}
