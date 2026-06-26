import type { AppContext } from "../types";
import { writeAdminAuditLog } from "./admin-security";

export type BlockedIpRecord = {
  id: number;
  ip_hash: string;
  reason: string;
  failed_count: number;
  blocked_at: string;
  blocked_until: string | null;
  manually_unblocked_at: string | null;
  manually_unblocked_by: number | null;
  admin_username: string | null;
};

export type BlockedIpActor = {
  adminUserId: number;
  ipHash: string;
  userAgentHash: string;
};

export function mapBlockedIp(record: BlockedIpRecord) {
  return {
    id: record.id,
    ipHash: record.ip_hash,
    reason: record.reason,
    failedCount: record.failed_count,
    blockedAt: record.blocked_at,
    blockedUntil: record.blocked_until,
    manuallyUnblockedAt: record.manually_unblocked_at,
    manuallyUnblockedBy: record.manually_unblocked_by,
    manuallyUnblockedByUsername: record.admin_username,
    status: record.manually_unblocked_at ? "unblocked" : "blocked",
  };
}

export async function listBlockedIps(c: AppContext, includeHistory = false) {
  const query = `
    SELECT
      b.id,
      b.ip_hash,
      b.reason,
      b.failed_count,
      b.blocked_at,
      b.blocked_until,
      b.manually_unblocked_at,
      b.manually_unblocked_by,
      u.username AS admin_username
    FROM admin_blocked_ips b
    LEFT JOIN admin_users u ON u.id = b.manually_unblocked_by
    ${includeHistory ? "" : [
      "WHERE b.manually_unblocked_at IS NULL",
      "AND b.reason = 'too_many_failures'",
      "AND (b.blocked_until IS NULL OR b.blocked_until > datetime('now'))",
    ].join(" ")}
    ORDER BY b.blocked_at DESC, b.id DESC
  `;

  const result = await c.env.merlin_db.prepare(query).all<BlockedIpRecord>();
  return result.results.map(mapBlockedIp);
}

export async function unblockBlockedIp(c: AppContext, id: number, actor: BlockedIpActor) {
  const existing = await c.env.merlin_db
    .prepare(
      `
        SELECT id, ip_hash, reason, failed_count, blocked_at, blocked_until, manually_unblocked_at, manually_unblocked_by, NULL AS admin_username
        FROM admin_blocked_ips
        WHERE id = ?
      `,
    )
    .bind(id)
    .first<BlockedIpRecord>();

  if (!existing) {
    throw new Error("Blocked IP not found");
  }

  await c.env.merlin_db
    .prepare(
      `
        UPDATE admin_blocked_ips
        SET failed_count = 0,
            blocked_until = NULL,
            manually_unblocked_at = ?,
            manually_unblocked_by = ?,
            reason = 'manually_unblocked'
        WHERE id = ?
      `,
    )
    .bind(new Date().toISOString(), actor.adminUserId, id)
    .run();

  await writeAdminAuditLog(c, {
    adminUserId: actor.adminUserId,
    action: "admin_ip_unblocked",
    entityType: "blocked_ip",
    entityId: String(id),
    ipHash: actor.ipHash,
    userAgentHash: actor.userAgentHash,
    metadata: { blockedIpHash: existing.ip_hash },
  });

  const updated = await c.env.merlin_db
    .prepare(
      `
        SELECT b.id, b.ip_hash, b.reason, b.failed_count, b.blocked_at, b.blocked_until, b.manually_unblocked_at, b.manually_unblocked_by, u.username AS admin_username
        FROM admin_blocked_ips b
        LEFT JOIN admin_users u ON u.id = b.manually_unblocked_by
        WHERE b.id = ?
      `,
    )
    .bind(id)
    .first<BlockedIpRecord>();

  return updated ? mapBlockedIp(updated) : null;
}
