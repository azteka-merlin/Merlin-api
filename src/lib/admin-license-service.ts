import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { generateLicenseKey, toDateOnly, toIsoDateStart, type LicenseRecord } from "./licenses";
import { writeAdminAuditLog } from "./admin-security";

export type LicenseActionActor = {
  adminUserId: number;
  ipHash: string;
  userAgentHash: string;
};

export function mapLicense(record: LicenseRecord) {
  return {
    id: record.id,
    licenseKey: record.license_key,
    name: record.name,
    phone: record.phone,
    hwid: record.hwid,
    expiresAt: toDateOnly(record.expires_at),
    status: record.status,
    revokedReason: record.revoked_reason,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function listLicenses(c: AppContext) {
  const result = await c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, phone, hwid, expires_at, status, revoked_reason, created_at, updated_at
        FROM licenses
        ORDER BY id DESC
      `,
    )
    .all<LicenseRecord>();

  return result.results.map(mapLicense);
}

export async function getLicense(c: AppContext, id: number) {
  const license = await c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, phone, hwid, expires_at, status, revoked_reason, created_at, updated_at
        FROM licenses
        WHERE id = ?
      `,
    )
    .bind(id)
    .first<LicenseRecord>();

  if (!license) {
    throw new HTTPException(404, { message: "License not found" });
  }

  return license;
}

function normalizeStoredPhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits.slice(2);
  }
  return digits.slice(0, 11);
}

export async function createLicense(
  c: AppContext,
  input: { name: string; phone: string; expiresAt: string },
  actor?: LicenseActionActor,
) {
  const now = new Date().toISOString();
  const expiresAt = toIsoDateStart(input.expiresAt);
  const normalizedPhone = normalizeStoredPhone(input.phone);
  if (normalizedPhone.length !== 11) {
    throw new HTTPException(400, { message: "A valid Brazilian cellphone number with area code is required" });
  }
  if (normalizedPhone.length !== 11) {
    throw new HTTPException(400, { message: "A valid Brazilian cellphone number with area code is required" });
  }
  let licenseKey = generateLicenseKey();
  let insertResult: D1Result<Record<string, unknown>> | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      insertResult = await c.env.merlin_db
        .prepare(
          `
            INSERT INTO licenses (
              license_key, name, phone, hwid, expires_at, status, revoked_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
          `,
        )
        .bind(licenseKey, input.name, normalizedPhone, null, expiresAt, null, now, now)
        .run();
      break;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      licenseKey = generateLicenseKey();
    }
  }

  const created = await getLicense(c, Number(insertResult?.meta.last_row_id));
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_created",
      entityType: "license",
      entityId: String(created.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
      metadata: { licenseKey: created.license_key },
    });
  }
  return created;
}

export async function updateLicense(
  c: AppContext,
  id: number,
  input: { name: string; phone: string; expiresAt: string; hwid: string | null },
  actor?: LicenseActionActor,
) {
  const current = await getLicense(c, id);
  const nextHwid = input.hwid?.trim() || null;
  const normalizedPhone = normalizeStoredPhone(input.phone);
  await c.env.merlin_db
    .prepare(
      `
        UPDATE licenses
        SET name = ?, phone = ?, hwid = ?, expires_at = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(input.name, normalizedPhone, nextHwid, toIsoDateStart(input.expiresAt), new Date().toISOString(), current.id)
    .run();

  const updated = await getLicense(c, id);
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_updated",
      entityType: "license",
      entityId: String(updated.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
    });
  }
  return updated;
}

export async function renewLicense(c: AppContext, id: number, expiresAt: string, actor?: LicenseActionActor) {
  await getLicense(c, id);
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(toIsoDateStart(expiresAt), new Date().toISOString(), id)
    .run();
  const updated = await getLicense(c, id);
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_renewed",
      entityType: "license",
      entityId: String(updated.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
    });
  }
  return updated;
}

export async function revokeLicense(c: AppContext, id: number, reason: string, actor?: LicenseActionActor) {
  await getLicense(c, id);
  const normalizedReason = reason.trim();
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET status = 'revoked', revoked_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(normalizedReason, new Date().toISOString(), id)
    .run();
  const updated = await getLicense(c, id);
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_revoked",
      entityType: "license",
      entityId: String(updated.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
      metadata: { reason: normalizedReason },
    });
  }
  return updated;
}

export async function reactivateLicense(c: AppContext, id: number, actor?: LicenseActionActor) {
  await getLicense(c, id);
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET status = 'active', revoked_reason = NULL, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();
  const updated = await getLicense(c, id);
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_reactivated",
      entityType: "license",
      entityId: String(updated.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
    });
  }
  return updated;
}

export async function resetLicenseHwid(c: AppContext, id: number, actor?: LicenseActionActor) {
  await getLicense(c, id);
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET hwid = NULL, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();
  const updated = await getLicense(c, id);
  if (actor) {
    await writeAdminAuditLog(c, {
      adminUserId: actor.adminUserId,
      action: "license_hwid_reset",
      entityType: "license",
      entityId: String(updated.id),
      ipHash: actor.ipHash,
      userAgentHash: actor.userAgentHash,
    });
  }
  return updated;
}
