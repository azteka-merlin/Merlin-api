import type { AppContext } from "../types";

export type AdminAuditLogRecord = {
  id: number;
  admin_user_id: number | null;
  admin_username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type ListAdminAuditLogsInput = {
  limit?: number;
  action?: string;
  adminUserId?: number | null;
  search?: string;
};

function parseMetadata(metadataJson: string | null) {
  if (!metadataJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function mapAdminAuditLog(record: AdminAuditLogRecord) {
  const metadata = parseMetadata(record.metadata_json);
  const metadataUsername = metadata && typeof metadata.username === "string" ? metadata.username : null;

  return {
    id: record.id,
    adminUserId: record.admin_user_id,
    adminUsername: record.admin_username,
    actorName: record.admin_username || metadataUsername || "Sistema",
    action: record.action,
    entityType: record.entity_type,
    entityId: record.entity_id,
    ipHash: record.ip_hash,
    userAgentHash: record.user_agent_hash,
    metadata,
    createdAt: record.created_at,
  };
}

export async function listAdminAuditLogs(c: AppContext, input: ListAdminAuditLogsInput = {}) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];

  if (input.action) {
    conditions.push("a.action = ?");
    bindings.push(input.action);
  }

  if (input.adminUserId) {
    conditions.push("a.admin_user_id = ?");
    bindings.push(input.adminUserId);
  }

  if (input.search) {
    conditions.push("(LOWER(COALESCE(u.username, '')) LIKE ? OR LOWER(COALESCE(a.action, '')) LIKE ? OR LOWER(COALESCE(a.entity_type, '')) LIKE ? OR LOWER(COALESCE(a.entity_id, '')) LIKE ? OR LOWER(COALESCE(a.metadata_json, '')) LIKE ?)");
    const like = `%${input.search.trim().toLowerCase()}%`;
    bindings.push(like, like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT
      a.id,
      a.admin_user_id,
      u.username AS admin_username,
      a.action,
      a.entity_type,
      a.entity_id,
      a.ip_hash,
      a.user_agent_hash,
      a.metadata_json,
      a.created_at
    FROM admin_audit_logs a
    LEFT JOIN admin_users u ON u.id = a.admin_user_id
    ${whereClause}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ?
  `;

  const result = await c.env.merlin_db.prepare(query).bind(...bindings, limit).all<AdminAuditLogRecord>();
  return result.results.map(mapAdminAuditLog);
}
