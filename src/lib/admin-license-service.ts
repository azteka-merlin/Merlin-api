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

const DUPLICATE_EMAIL_LICENSE_MESSAGE = "Este e-mail já possui uma licença cadastrada.";

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
    revokedOrigin: record.revoked_origin || null,
    revokedEventId: record.revoked_event_id || null,
    customerId: record.customer_id ?? null,
    accessType: record.access_type || "free",
    billingStatus: record.billing_status || "none",
    stripeCustomerId: record.stripe_customer_id || null,
    stripeSubscriptionId: record.stripe_subscription_id || null,
    stripeCheckoutSessionId: record.stripe_checkout_session_id || null,
    billingCurrentPeriodEnd: record.billing_current_period_end || null,
    billingCancelAtPeriodEnd: Boolean(record.billing_cancel_at_period_end),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export async function listLicenses(c: AppContext) {
  const billingColumns = `
    customer_id,
    COALESCE(access_type, 'free') AS access_type,
    COALESCE(billing_status, 'none') AS billing_status,
    stripe_customer_id,
    stripe_subscription_id,
    stripe_checkout_session_id,
    billing_current_period_end,
    billing_cancel_at_period_end
  `;
  const result = await c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          ${billingColumns},
          created_at, updated_at
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
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          customer_id,
          COALESCE(access_type, 'free') AS access_type,
          COALESCE(billing_status, 'none') AS billing_status,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_checkout_session_id,
          billing_current_period_end,
          billing_cancel_at_period_end,
          created_at, updated_at
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

export async function findLicenseByEmailContact(c: AppContext, email: string, excludeId?: number) {
  const normalizedEmail = normalizeContact(email, "email");
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          customer_id,
          COALESCE(access_type, 'free') AS access_type,
          COALESCE(billing_status, 'none') AS billing_status,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_checkout_session_id,
          billing_current_period_end,
          billing_cancel_at_period_end,
          created_at, updated_at
        FROM licenses
        WHERE contact_type = 'email'
          AND lower(contact) = ?
          AND (? IS NULL OR id <> ?)
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(normalizedEmail, excludeId ?? null, excludeId ?? null)
    .first<LicenseRecord>();
}

async function assertEmailContactAvailable(c: AppContext, contactType: ContactType, contact: string, excludeId?: number) {
  if (contactType !== "email") {
    return;
  }

  const existing = await findLicenseByEmailContact(c, contact, excludeId);
  if (existing) {
    throw new HTTPException(409, { message: DUPLICATE_EMAIL_LICENSE_MESSAGE });
  }
}

function isDuplicateEmailLicenseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("idx_licenses_unique_email_contact");
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
  await assertEmailContactAvailable(c, contactType, normalizedContact);
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
      if (isDuplicateEmailLicenseError(error)) {
        throw new HTTPException(409, { message: DUPLICATE_EMAIL_LICENSE_MESSAGE });
      }
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
  await assertEmailContactAvailable(c, contactType, normalizedContact, current.id);
  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  const recoveryPinHash = recoveryPin ? await hashRecoveryPin(c, { licenseKey: current.license_key, recoveryPin }) : null;
  const recoveryPinSql = recoveryPin ? ", recovery_pin_hash = ?, recovery_notice_accepted_at = ?" : "";
  const recoveryPinBindings = recoveryPin ? [recoveryPinHash, new Date().toISOString()] : [];
  const now = new Date().toISOString();
  try {
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
  } catch (error) {
    if (isDuplicateEmailLicenseError(error)) {
      throw new HTTPException(409, { message: DUPLICATE_EMAIL_LICENSE_MESSAGE });
    }
    throw error;
  }

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
    .prepare(`UPDATE licenses SET status = 'revoked', revoked_reason = ?, revoked_origin = 'admin', revoked_event_id = NULL, updated_at = ? WHERE id = ?`)
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
    .prepare(`UPDATE licenses SET status = 'active', revoked_reason = NULL, revoked_origin = NULL, revoked_event_id = NULL, updated_at = ? WHERE id = ?`)
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
