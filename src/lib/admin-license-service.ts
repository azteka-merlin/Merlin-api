import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { generateLicenseKey, resolveLicenseStatus, toDateOnly, toIsoDateStart, type LicenseRecord, type LicenseStatusValue } from "./licenses";
import { writeAdminAuditLog } from "./admin-security";
import { hashRecoveryPin, normalizeRecoveryPin } from "./recovery-pin";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";

export type ContactType = "phone" | "email" | "discord" | "none";
export type LicenseType = "normal" | "test";

export type LicenseActionActor = {
  adminUserId: number;
  ipHash: string;
  userAgentHash: string;
};

const DUPLICATE_EMAIL_LICENSE_MESSAGE = "Este e-mail já possui uma licença cadastrada.";
const TEST_LICENSE_DEFAULT_EXPIRY = "9999-12-31";

const licenseActivationSelect = `
  COALESCE(license_type, 'normal') AS license_type,
  normal_activation_limit,
  premium_activation_limit,
  activation_usage_reset_at,
  (
    SELECT COUNT(DISTINCT ual.app_id)
    FROM user_activity_logs ual
    WHERE ual.license_id = licenses.id
      AND ual.action = 'game_activation_success'
      AND ual.app_id IS NOT NULL
      AND (licenses.activation_usage_reset_at IS NULL OR ual.created_at > licenses.activation_usage_reset_at)
  ) AS normal_activation_used,
  (
    SELECT COUNT(*)
    FROM premium_activations pa
    WHERE pa.license_id = licenses.id
      AND pa.status IN ('reserved', 'active', 'expired')
      AND (licenses.activation_usage_reset_at IS NULL OR pa.created_at > licenses.activation_usage_reset_at)
  ) AS premium_activation_used
`;

function statusForExpiresAt(expiresAt: string, currentStatus?: LicenseStatusValue): LicenseStatusValue {
  if (currentStatus === "revoked") {
    return "revoked";
  }
  return resolveLicenseStatus({ status: "active", expires_at: expiresAt });
}

export function mapLicense(record: LicenseRecord) {
  return {
    id: record.id,
    licenseKey: record.license_key,
    name: record.name,
    contact: record.contact,
    contactType: record.contact_type,
    source: record.source,
    licenseType: record.license_type || "normal",
    planTier: record.license_type === "test" ? null : record.plan_tier || "ouro",
    premiumCatalogRestricted: record.premium_catalog_restricted === 1,
    normalActivationLimit: record.normal_activation_limit ?? null,
    premiumActivationLimit: record.premium_activation_limit ?? null,
    normalActivationUsed: record.normal_activation_used ?? 0,
    premiumActivationUsed: record.premium_activation_used ?? 0,
    activationUsageResetAt: record.activation_usage_reset_at || null,
    hasRecoveryPin: Boolean(record.recovery_pin_hash),
    recoveryNoticeAcceptedAt: record.recovery_notice_accepted_at,
    phone: record.contact,
    hwid: record.hwid,
    expiresAt: toDateOnly(record.expires_at),
    status: resolveLicenseStatus(record),
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
    billingCurrentPeriodStart: record.billing_current_period_start || null,
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
    billing_current_period_start,
    billing_cancel_at_period_end
  `;
  const result = await c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source,
          ${licenseActivationSelect},
          recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          plan_tier,
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
        SELECT id, license_key, name, contact, contact_type, source,
          ${licenseActivationSelect},
          recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          plan_tier,
          COALESCE(premium_catalog_restricted, 0) AS premium_catalog_restricted,
          customer_id,
          COALESCE(access_type, 'free') AS access_type,
          COALESCE(billing_status, 'none') AS billing_status,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_checkout_session_id,
          billing_current_period_end,
          billing_current_period_start,
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
  if (contactType === "none" && contact.length > 0) {
    throw new HTTPException(400, { message: "Contact must be empty for this license type" });
  }
}

export async function findLicenseByEmailContact(c: AppContext, email: string, excludeId?: number) {
  const normalizedEmail = normalizeContact(email, "email");
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source,
          ${licenseActivationSelect},
          recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, revoked_origin, revoked_event_id,
          plan_tier,
          customer_id,
          COALESCE(access_type, 'free') AS access_type,
          COALESCE(billing_status, 'none') AS billing_status,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_checkout_session_id,
          billing_current_period_end,
          billing_current_period_start,
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

function normalizeActivationLimit(value: number | null | undefined, label: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 9999) {
    throw new HTTPException(400, { message: `Informe um limite de ativacoes ${label} valido.` });
  }
  return numeric;
}

export async function createLicense(
  c: AppContext,
  input: {
    name: string;
    contact?: string;
    contactType?: ContactType;
    phone?: string;
    recoveryPin?: string;
    expiresAt?: string;
    licenseType?: LicenseType;
    normalActivationLimit?: number | null;
    premiumActivationLimit?: number | null;
    planTier?: PlanTier | null;
  },
  actor?: LicenseActionActor,
) {
  const now = new Date().toISOString();
  const licenseType = input.licenseType || "normal";
  const expiresAt = toIsoDateStart(licenseType === "test" ? TEST_LICENSE_DEFAULT_EXPIRY : String(input.expiresAt || ""));
  const status = statusForExpiresAt(expiresAt);
  const contactType = licenseType === "test" ? "none" : input.contactType || "phone";
  const normalizedContact = licenseType === "test" ? "" : normalizeContact(input.contact || input.phone || "", contactType);
  const normalActivationLimit = licenseType === "test" ? normalizeActivationLimit(input.normalActivationLimit, "normal") : null;
  const premiumActivationLimit = licenseType === "test" ? normalizeActivationLimit(input.premiumActivationLimit, "premium") : null;
  const planTier = licenseType === "test" ? null : normalizeStoredPlanTier(input.planTier, "ouro");
  assertValidContact(normalizedContact, contactType);
  await assertEmailContactAvailable(c, contactType, normalizedContact);
  const recoveryPin = licenseType === "test" ? "" : normalizeRecoveryPin(input.recoveryPin);
  let licenseKey = generateLicenseKey();
  let insertResult: D1Result<Record<string, unknown>> | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const recoveryPinHash = recoveryPin ? await hashRecoveryPin(c, { licenseKey, recoveryPin }) : null;
    try {
      insertResult = await c.env.merlin_db
        .prepare(
          `
            INSERT INTO licenses (
              license_key, name, contact, contact_type, source, license_type, plan_tier, normal_activation_limit, premium_activation_limit, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(licenseKey, input.name, normalizedContact, contactType, licenseType, planTier, normalActivationLimit, premiumActivationLimit, recoveryPinHash, recoveryPin ? now : null, null, expiresAt, status, null, now, now)
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
      metadata: { licenseKey: created.license_key, licenseType },
    });
  }
  return created;
}

export async function updateLicense(
  c: AppContext,
  id: number,
  input: { name: string; contact?: string; contactType?: ContactType; phone?: string; recoveryPin?: string; expiresAt: string; hwid: string | null; planTier?: PlanTier | null },
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
  const expiresAt = toIsoDateStart(input.expiresAt);
  const nextStatus = statusForExpiresAt(expiresAt, current.status);
  const planTier = normalizeStoredPlanTier(input.planTier || current.plan_tier, "ouro");
  try {
    await c.env.merlin_db
      .prepare(
        `
          UPDATE licenses
          SET name = ?, contact = ?, contact_type = ?, hwid = ?, expires_at = ?, status = ?, plan_tier = ?${recoveryPinSql}, updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(input.name, normalizedContact, contactType, nextHwid, expiresAt, nextStatus, planTier, ...recoveryPinBindings, now, current.id)
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

export async function updateTestLicense(
  c: AppContext,
  id: number,
  input: { name: string; normalActivationLimit: number; premiumActivationLimit: number },
  actor?: LicenseActionActor,
) {
  const current = await getLicense(c, id);
  if ((current.license_type || "normal") !== "test") {
    throw new HTTPException(400, { message: "Esta licença não é uma licença de teste." });
  }

  const name = String(input.name || "").trim();
  if (!name) {
    throw new HTTPException(400, { message: "Informe o nome do teste." });
  }

  const normalActivationLimit = normalizeActivationLimit(input.normalActivationLimit, "normal");
  const premiumActivationLimit = normalizeActivationLimit(input.premiumActivationLimit, "premium");
  const now = new Date().toISOString();

  await c.env.merlin_db
    .prepare(
      `
        UPDATE licenses
        SET name = ?, normal_activation_limit = ?, premium_activation_limit = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(name, normalActivationLimit, premiumActivationLimit, now, current.id)
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
      metadata: {
        licenseType: "test",
        normalActivationLimit,
        premiumActivationLimit,
      },
    });
  }
  return updated;
}

export async function resetTestLicenseUsage(c: AppContext, id: number, actor?: LicenseActionActor) {
  const current = await getLicense(c, id);
  if ((current.license_type || "normal") !== "test") {
    throw new HTTPException(400, { message: "Esta licença não é uma licença de teste." });
  }

  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET activation_usage_reset_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, current.id)
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
      metadata: { licenseType: "test", resetUsageAt: now },
    });
  }
  return updated;
}

export async function renewLicense(c: AppContext, id: number, expiresAt: string, actor?: LicenseActionActor) {
  const current = await getLicense(c, id);
  const nextExpiresAt = toIsoDateStart(expiresAt);
  const nextStatus = statusForExpiresAt(nextExpiresAt, current.status);
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET expires_at = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(nextExpiresAt, nextStatus, new Date().toISOString(), id)
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
  const current = await getLicense(c, id);
  const nextStatus = statusForExpiresAt(current.expires_at);
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET status = ?, revoked_reason = NULL, revoked_origin = NULL, revoked_event_id = NULL, updated_at = ? WHERE id = ?`)
    .bind(nextStatus, new Date().toISOString(), id)
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
