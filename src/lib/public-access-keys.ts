import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { generateLicenseKey, toDateOnly, toIsoDateStart, type LicenseRecord } from "./licenses";
import { assertValidContact, normalizeContact, type ContactType } from "./admin-license-service";
import { assertRecentPublicEmailVerification, consumePublicEmailVerification } from "./email-verification";

export type PublicSignupDurationUnit = "days" | "weeks" | "months" | "years";

type PublicSignupSettingsRow = {
  id: number;
  enabled: number;
  duration_amount: number;
  duration_unit: PublicSignupDurationUnit;
  is_lifetime: number;
  updated_at: string;
};

type PublicSignupSettingsInput = {
  enabled: boolean;
  durationAmount: number;
  durationUnit: PublicSignupDurationUnit;
  isLifetime: boolean;
};

const GENERIC_RECOVERY_ERROR = "Could not recover this access key with the provided information";
const LIFETIME_EXPIRES_AT = "9999-12-31";

function mapSettings(row: PublicSignupSettingsRow) {
  return {
    enabled: row.enabled === 1,
    durationAmount: row.duration_amount,
    durationUnit: row.duration_unit,
    isLifetime: row.is_lifetime === 1,
    updatedAt: row.updated_at,
  };
}

function mapPublicLicense(record: LicenseRecord) {
  return {
    licenseKey: record.license_key,
    name: record.name,
    contact: record.contact,
    contactType: record.contact_type,
    expiresAt: toDateOnly(record.expires_at),
    status: record.status,
  };
}

function getPublicDescription(settings: ReturnType<typeof mapSettings>) {
  if (settings.isLifetime) {
    return "Novas chaves de acesso serão vitalícias.";
  }

  const labels: Record<PublicSignupDurationUnit, string> = {
    days: settings.durationAmount === 1 ? "dia" : "dias",
    weeks: settings.durationAmount === 1 ? "semana" : "semanas",
    months: settings.durationAmount === 1 ? "mês" : "meses",
    years: settings.durationAmount === 1 ? "ano" : "anos",
  };

  return `Novas chaves de acesso vencerão em ${settings.durationAmount} ${labels[settings.durationUnit]}.`;
}

export async function getPublicSignupSettings(c: AppContext) {
  const row = await c.env.merlin_db
    .prepare(
      `
        SELECT id, enabled, duration_amount, duration_unit, is_lifetime, updated_at
        FROM public_signup_settings
        WHERE id = 1
      `,
    )
    .first<PublicSignupSettingsRow>();

  if (row) {
    return mapSettings(row);
  }

  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO public_signup_settings (id, enabled, duration_amount, duration_unit, is_lifetime, updated_at)
        VALUES (1, 0, 30, 'days', 0, ?)
      `,
    )
    .bind(now)
    .run();

  return {
    enabled: false,
    durationAmount: 30,
    durationUnit: "days" as const,
    isLifetime: false,
    updatedAt: now,
  };
}

export function getPublicSignupSettingsPayload(settings: Awaited<ReturnType<typeof getPublicSignupSettings>>) {
  return {
    ...settings,
    description: getPublicDescription(settings),
  };
}

export async function updatePublicSignupSettings(c: AppContext, input: PublicSignupSettingsInput) {
  if (!input.isLifetime && (!Number.isInteger(input.durationAmount) || input.durationAmount <= 0)) {
    throw new HTTPException(400, { message: "A valid duration amount is required" });
  }

  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO public_signup_settings (id, enabled, duration_amount, duration_unit, is_lifetime, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          duration_amount = excluded.duration_amount,
          duration_unit = excluded.duration_unit,
          is_lifetime = excluded.is_lifetime,
          updated_at = excluded.updated_at
      `,
    )
    .bind(input.enabled ? 1 : 0, input.durationAmount, input.durationUnit, input.isLifetime ? 1 : 0, now)
    .run();

  return getPublicSignupSettings(c);
}

function addDuration(start: Date, amount: number, unit: PublicSignupDurationUnit) {
  const next = new Date(start.getTime());
  if (unit === "days") {
    next.setUTCDate(next.getUTCDate() + amount);
  } else if (unit === "weeks") {
    next.setUTCDate(next.getUTCDate() + amount * 7);
  } else if (unit === "months") {
    next.setUTCMonth(next.getUTCMonth() + amount);
  } else {
    next.setUTCFullYear(next.getUTCFullYear() + amount);
  }
  return next.toISOString().slice(0, 10);
}

function calculateExpiresAt(settings: Awaited<ReturnType<typeof getPublicSignupSettings>>) {
  if (settings.isLifetime) {
    return LIFETIME_EXPIRES_AT;
  }
  return addDuration(new Date(), settings.durationAmount, settings.durationUnit);
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashRecoveryPin(c: AppContext, input: { contact: string; contactType: ContactType; recoveryPin: string }) {
  const secret = String(c.env.SESSION_HASH_SECRET || "").trim();
  if (!secret) {
    throw new HTTPException(500, { message: "SESSION_HASH_SECRET is not configured" });
  }
  return sha256Hex(`${secret}:${input.contactType}:${input.contact}:${input.recoveryPin}`);
}

async function findLatestActiveLicenseByContact(c: AppContext, contact: string, contactType: ContactType) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
        FROM licenses
        WHERE contact = ?
          AND contact_type = ?
          AND status = 'active'
          AND datetime(expires_at) >= datetime('now')
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(contact, contactType)
    .first<LicenseRecord>();
}

async function compareRecoveryPin(c: AppContext, license: LicenseRecord, recoveryPin: string) {
  if (!license.recovery_pin_hash) {
    return false;
  }
  const expected = await hashRecoveryPin(c, {
    contact: license.contact,
    contactType: license.contact_type,
    recoveryPin,
  });
  return expected === license.recovery_pin_hash;
}

export function normalizePublicAccessContact(value: string, contactType: ContactType) {
  const contact = normalizeContact(value, contactType);
  assertValidContact(contact, contactType);
  return contact;
}

export async function registerPublicAccessKey(
  c: AppContext,
  input: {
    name: string;
    contact: string;
    contactType: ContactType;
    recoveryPin: string;
    acceptedRecoveryNotice: boolean;
  },
) {
  const settings = await getPublicSignupSettings(c);
  if (!settings.enabled) {
    throw new HTTPException(403, { message: "Public access key signup is disabled" });
  }
  if (!input.acceptedRecoveryNotice) {
    throw new HTTPException(400, { message: "Recovery notice must be accepted" });
  }

  const name = input.name.trim();
  if (!name) {
    throw new HTTPException(400, { message: "Name is required" });
  }
  const recoveryPin = input.recoveryPin.trim();
  if (!/^\d{4,8}$/.test(recoveryPin)) {
    throw new HTTPException(400, { message: "Recovery PIN must contain 4 to 8 digits" });
  }

  const contact = normalizePublicAccessContact(input.contact, input.contactType);
  const emailVerificationId = input.contactType === "email"
    ? await assertRecentPublicEmailVerification(c, contact)
    : null;
  const existing = await findLatestActiveLicenseByContact(c, contact, input.contactType);
  if (existing) {
    const matchesPin = await compareRecoveryPin(c, existing, recoveryPin);
    if (!matchesPin) {
      throw new HTTPException(400, { message: "PUBLIC_ACCESS_KEY_UNAVAILABLE" });
    }
    if (emailVerificationId) {
      await consumePublicEmailVerification(c, emailVerificationId);
    }
    return { license: mapPublicLicense(existing), created: false };
  }

  const now = new Date().toISOString();
  const expiresAt = toIsoDateStart(calculateExpiresAt(settings));
  const recoveryPinHash = await hashRecoveryPin(c, { contact, contactType: input.contactType, recoveryPin });
  let licenseKey = generateLicenseKey();
  let insertResult: D1Result<Record<string, unknown>> | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      insertResult = await c.env.merlin_db
        .prepare(
          `
            INSERT INTO licenses (
              license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 'public_signup', ?, ?, NULL, ?, 'active', NULL, ?, ?)
          `,
        )
        .bind(licenseKey, name, contact, input.contactType, recoveryPinHash, now, expiresAt, now, now)
        .run();
      break;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      licenseKey = generateLicenseKey();
    }
  }

  const created = await c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status, revoked_reason, created_at, updated_at
        FROM licenses
        WHERE id = ?
      `,
    )
    .bind(Number(insertResult?.meta.last_row_id))
    .first<LicenseRecord>();

  if (!created) {
    throw new HTTPException(500, { message: "Could not create access key" });
  }
  if (emailVerificationId) {
    await consumePublicEmailVerification(c, emailVerificationId);
  }

  return { license: mapPublicLicense(created), created: true };
}

export async function recoverPublicAccessKey(
  c: AppContext,
  input: { contact: string; contactType: ContactType; recoveryPin: string },
) {
  const recoveryPin = input.recoveryPin.trim();
  if (!/^\d{4,8}$/.test(recoveryPin)) {
    throw new HTTPException(401, { message: GENERIC_RECOVERY_ERROR });
  }

  const contact = normalizePublicAccessContact(input.contact, input.contactType);
  const emailVerificationId = input.contactType === "email"
    ? await assertRecentPublicEmailVerification(c, contact)
    : null;
  const existing = await findLatestActiveLicenseByContact(c, contact, input.contactType);
  if (!existing) {
    throw new HTTPException(401, { message: GENERIC_RECOVERY_ERROR });
  }

  const matchesPin = await compareRecoveryPin(c, existing, recoveryPin);
  if (!matchesPin) {
    throw new HTTPException(401, { message: GENERIC_RECOVERY_ERROR });
  }
  if (emailVerificationId) {
    await consumePublicEmailVerification(c, emailVerificationId);
  }

  return { license: mapPublicLicense(existing) };
}

export async function getPublicSignupMetrics(c: AppContext) {
  const row = await c.env.merlin_db
    .prepare(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' AND datetime(expires_at) >= datetime('now') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN datetime(expires_at) < datetime('now') THEN 1 ELSE 0 END) AS expired,
          MAX(created_at) AS latest_created_at
        FROM licenses
        WHERE source = 'public_signup'
      `,
    )
    .first<{ total: number; active: number | null; expired: number | null; latest_created_at: string | null }>();

  return {
    total: row?.total || 0,
    active: row?.active || 0,
    expired: row?.expired || 0,
    latestCreatedAt: row?.latest_created_at || null,
  };
}
