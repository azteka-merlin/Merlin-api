import type { AppContext } from "../types";

export type UserActivityLogRecord = {
  id: number;
  license_id: number;
  license_key: string;
  user_name: string;
  action: string;
  status: string;
  app_id: string | null;
  game_name: string | null;
  ip_address: string | null;
  hwid: string | null;
  reason: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type UserActivityInput = {
  licenseId: number;
  licenseKey: string;
  userName: string;
  action:
    | "user_login_success"
    | "game_activation_success"
    | "game_activation_denied"
    | "premium_activation_success"
    | "premium_activation_failed";
  status: "success" | "denied";
  appId?: string | null;
  gameName?: string | null;
  ipAddress?: string | null;
  hwid?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

function parseMetadata(metadataJson: string | null) {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function mapUserActivityLog(record: UserActivityLogRecord) {
  return {
    id: record.id,
    licenseId: record.license_id,
    licenseKey: record.license_key,
    userName: record.user_name,
    action: record.action,
    status: record.status,
    appId: record.app_id,
    gameName: record.game_name,
    ipAddress: record.ip_address,
    hwid: record.hwid,
    reason: record.reason,
    metadata: parseMetadata(record.metadata_json),
    createdAt: record.created_at,
  };
}

export async function writeUserActivityLog(c: AppContext, input: UserActivityInput) {
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO user_activity_logs (
          license_id,
          license_key,
          user_name,
          action,
          status,
          app_id,
          game_name,
          ip_address,
          hwid,
          reason,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      input.licenseId,
      input.licenseKey,
      input.userName,
      input.action,
      input.status,
      input.appId ?? null,
      input.gameName ?? null,
      input.ipAddress ?? null,
      input.hwid ?? null,
      input.reason ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function listUserActivityLogs(
  c: AppContext,
  input: { limit?: number; action?: string; status?: string; search?: string } = {},
) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];

  if (input.action) {
    conditions.push("action = ?");
    bindings.push(input.action);
  }

  if (input.status) {
    conditions.push("status = ?");
    bindings.push(input.status);
  }

  if (input.search) {
    const like = `%${input.search.trim().toLowerCase()}%`;
    conditions.push("(LOWER(user_name) LIKE ? OR LOWER(license_key) LIKE ? OR LOWER(COALESCE(app_id, '')) LIKE ? OR LOWER(COALESCE(game_name, '')) LIKE ? OR LOWER(COALESCE(ip_address, '')) LIKE ? OR LOWER(COALESCE(reason, '')) LIKE ?)");
    bindings.push(like, like, like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT
      id,
      license_id,
      license_key,
      user_name,
      action,
      status,
      app_id,
      game_name,
      ip_address,
      hwid,
      reason,
      metadata_json,
      created_at
    FROM user_activity_logs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;

  const result = await c.env.merlin_db.prepare(query).bind(...bindings, limit).all<UserActivityLogRecord>();
  return result.results.map(mapUserActivityLog);
}
