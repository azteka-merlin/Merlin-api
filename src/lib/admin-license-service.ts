import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { generateLicenseKey, toDateOnly, toIsoDateStart, type LicenseRecord } from "./licenses";
import { writeAdminAuditLog } from "./admin-security";
import { hashRecoveryPin, normalizeRecoveryPin } from "./recovery-pin";

export type ContactType = "phone" | "email" | "discord";

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
    contact: record.contact,
    contactType: record.contact_type,
    source: record.source,
    hasRecoveryPin: Boolean(record.recovery_pin_hash),
    recoveryNoticeAcceptedAt: record.recovery_notice_accepted_at,
    phone: record.contact,
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
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
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
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
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

export function normalizeContact(value: string, contactType: ContactType) {
  if (contactType === "phone") {
    return normalizeStoredPhone(value);
  }
  return String(value || "").trim().toLowerCase();
}

export function assertValidContact(contact: string, contactType: ContactType) {
  if (contactType === "phone" && contact.length !== 11) {
    throw new HTTPException(400, { message: "A valid Brazilian cellphone number with area code is required" });
  }
  if (contactType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    throw new HTTPException(400, { message: "A valid email is required" });
  }
  if (contactType === "discord" && contact.length < 2) {
    throw new HTTPException(400, { message: "A valid Discord contact is required" });
  }
}

export async function createLicense(
  c: AppContext,
  input: { name: string; contact?: string; contactType?: ContactType; phone?: string; recoveryPin?: string; expiresAt: string },
  actor?: LicenseActionActor,
) {
  const now = new Date().toISOString();
  const expiresAt = toIsoDateStart(input.expiresAt);
  const contactType = input.contactType || "phone";
  const normalizedContact = normalizeContact(input.contact || input.phone || "", contactType);
  assertValidContact(normalizedContact, contactType);
  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  let licenseKey = generateLicenseKey();
  let insertResult: D1Result<Record<string, unknown>> | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const recoveryPinHash = recoveryPin ? await hashRecoveryPin(c, { licenseKey, recoveryPin }) : null;
    try {
      insertResult = await c.env.merlin_db
        .prepare(
          `
            INSERT INTO licenses (
              license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?, 'active', ?, ?, ?)
          `,
        )
        .bind(licenseKey, input.name, normalizedContact, contactType, recoveryPinHash, recoveryPin ? now : null, null, expiresAt, null, now, now)
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
  input: { name: string; contact?: string; contactType?: ContactType; phone?: string; recoveryPin?: string; expiresAt: string; hwid: string | null },
  actor?: LicenseActionActor,
) {
  const current = await getLicense(c, id);
  const nextHwid = input.hwid?.trim() || null;
  const contactType = input.contactType || current.contact_type || "phone";
  const normalizedContact = normalizeContact(input.contact || input.phone || "", contactType);
  assertValidContact(normalizedContact, contactType);
  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  const recoveryPinHash = recoveryPin ? await hashRecoveryPin(c, { licenseKey: current.license_key, recoveryPin }) : null;
  const recoveryPinSql = recoveryPin ? ", recovery_pin_hash = ?, recovery_notice_accepted_at = ?" : "";
  const recoveryPinBindings = recoveryPin ? [recoveryPinHash, new Date().toISOString()] : [];
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        UPDATE licenses
        SET name = ?, contact = ?, contact_type = ?, hwid = ?, expires_at = ?${recoveryPinSql}, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(input.name, normalizedContact, contactType, nextHwid, toIsoDateStart(input.expiresAt), ...recoveryPinBindings, now, current.id)
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
