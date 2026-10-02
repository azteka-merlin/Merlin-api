import type { AppBindings } from "../types";
import { sendBillingEmail, type BillingEmailKind } from "./billing-emails";

const PROVIDER_STRIPE = "stripe";
const PROVIDER_MERCADO_PAGO = "mercadopago";
const PROVIDER_MANUAL = "manual";
const REMINDER_WINDOW_DAYS = 7;
const BILLING_TIME_ZONE = "America/Sao_Paulo";
const CRON_LIMIT = 200;

type ReminderSlot = { kind: "reminder" | "expired"; days: number; code: string };

function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BILLING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour") };
}

function localDayNumber(date: Date) {
  const { year, month, day } = localParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function localDateAtOffset(now: Date, days: number) {
  return new Date((localDayNumber(now) + days) * 86_400_000).toISOString().slice(0, 10);
}

function slotsAt(now: Date): ReminderSlot[] {
  const hour = localParts(now).hour;
  if (hour === 9) return [
    { kind: "reminder", days: 7, code: "d-7" },
    { kind: "reminder", days: 4, code: "d-4" },
    { kind: "reminder", days: 2, code: "d-2" },
    { kind: "expired", days: -1, code: "d+1" },
  ];
  if (hour === 19) return [
    { kind: "reminder", days: 7, code: "d-7" }, // Catch D-7 after the exact seven-day renewal window opens.
    { kind: "reminder", days: 1, code: "d-1" },
    { kind: "expired", days: -2, code: "d+2" },
  ];
  return [];
}

function slotForExpiry(now: Date, expiresAt: string, kind: ReminderSlot["kind"]) {
  const days = localDayNumber(new Date(expiresAt)) - localDayNumber(now);
  return slotsAt(now).find((slot) => slot.kind === kind && slot.days === days) || null;
}

type BillingNotificationContext = {
  env: AppBindings;
};

type BillingNotificationRow = {
  id: number;
};

type BillingLicenseRow = {
  id: number;
  customer_id: number | null;
  license_key: string;
  name: string | null;
  contact: string;
  expires_at: string;
  access_type: string | null;
  billing_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_cancel_at_period_end: number | null;
  subscription_status: string | null;
  subscription_cancel_at_period_end: number | null;
  customer_stripe_customer_id: string | null;
};

type InvoiceLicenseRow = {
  id: number;
  customer_id: number | null;
  license_key: string;
  name: string | null;
  contact: string;
  expires_at: string;
  stripe_customer_id: string | null;
  customer_stripe_customer_id: string | null;
};

type StripeInvoiceLike = Record<string, unknown>;

function addDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateOnly(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

function displayExpiryDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BILLING_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date(value));
}

function publicOriginFromEnv(env: AppBindings) {
  return String(env.ENVIRONMENT || "").trim().toLowerCase() === "staging"
    ? "https://staging.api-merlin.com"
    : "https://api-merlin.com";
}

function publicAccessUrl(origin: string) {
  return `${origin}/download?access=me`;
}

function getObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getStripeId(value: unknown) {
  if (typeof value === "string") return value;
  const object = getObject(value);
  return getString(object?.id);
}

function invoiceAmount(invoice: StripeInvoiceLike) {
  const cents = getNumber(invoice.amount_due)
    ?? getNumber(invoice.amount_remaining)
    ?? getNumber(invoice.total)
    ?? null;
  if (cents === null) return null;
  const currency = String(getString(invoice.currency) || "brl").toUpperCase();
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function invoiceHostedUrl(invoice: StripeInvoiceLike) {
  return getString(invoice.hosted_invoice_url);
}

function maskLicenseKey(value: string | null | undefined) {
  const licenseKey = String(value || "").trim().toUpperCase();
  const parts = licenseKey.split("-");
  if (parts.length === 4) {
    return `${parts[0]}-****-****-${parts[3]}`;
  }
  if (licenseKey.length <= 8) return "MERLIN-****";
  return `${licenseKey.slice(0, 6)}****${licenseKey.slice(-4)}`;
}

async function reserveBillingNotification(
  c: BillingNotificationContext,
  input: {
    licenseId?: number | null;
    customerId?: number | null;
    provider: string;
    notificationType: string;
    dedupeKey: string;
    email: string;
  },
) {
  const now = new Date().toISOString();
  const stalePendingBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const reservation = await c.env.merlin_db
    .prepare(
      `
        INSERT INTO billing_notifications (
          license_id, customer_id, provider, notification_type, dedupe_key, email, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          status = 'pending',
          error_message = NULL,
          updated_at = excluded.updated_at
        WHERE billing_notifications.status = 'failed'
          OR (billing_notifications.status = 'pending' AND billing_notifications.updated_at < ?)
      `,
    )
    .bind(
      input.licenseId ?? null,
      input.customerId ?? null,
      input.provider,
      input.notificationType,
      input.dedupeKey,
      input.email,
      now,
      now,
      stalePendingBefore,
    )
    .run();

  if (!reservation.meta.changes) return null;

  const notification = await c.env.merlin_db
    .prepare(
      `
        SELECT id
        FROM billing_notifications
        WHERE dedupe_key = ?
          AND status = 'pending'
        LIMIT 1
      `,
    )
    .bind(input.dedupeKey)
    .first<BillingNotificationRow>();

  return notification?.id || null;
}

async function markBillingNotification(c: BillingNotificationContext, id: number, status: "sent" | "failed", errorMessage?: string) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        UPDATE billing_notifications
        SET status = ?,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
            error_message = ?,
            updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(status, status, now, errorMessage ? errorMessage.slice(0, 500) : null, now, id)
    .run();
}

async function sendOnce(
  c: BillingNotificationContext,
  input: {
    licenseId?: number | null;
    customerId?: number | null;
    provider: string;
    notificationType: BillingEmailKind;
    dedupeKey: string;
    email: string;
    name: string | null;
    ctaUrl: string;
    expiresAt?: string | null;
    daysUntilExpiry?: number | null;
    daysSinceExpiry?: number | null;
    invoiceAmount?: string | null;
    licenseKey?: string | null;
  },
) {
  const notificationId = await reserveBillingNotification(c, input);
  if (!notificationId) return false;

  try {
    await sendBillingEmail(c, {
      kind: input.notificationType,
      email: input.email,
      name: input.name,
      ctaUrl: input.ctaUrl,
      idempotencyKey: input.dedupeKey,
      expiresAt: input.expiresAt ? displayExpiryDate(input.expiresAt) : null,
      daysUntilExpiry: input.daysUntilExpiry,
      daysSinceExpiry: input.daysSinceExpiry,
      invoiceAmount: input.invoiceAmount,
      licenseKeyMasked: maskLicenseKey(input.licenseKey),
    });
    await markBillingNotification(c, notificationId, "sent");
    return true;
  } catch (error) {
    await markBillingNotification(c, notificationId, "failed", error instanceof Error ? error.message : String(error || ""));
    throw error;
  }
}

async function getInvoiceLicenseBySubscription(c: BillingNotificationContext, subscriptionId: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT l.id, l.customer_id, l.license_key, l.name, l.contact, l.expires_at,
               l.stripe_customer_id, cst.stripe_customer_id AS customer_stripe_customer_id
        FROM licenses l
        LEFT JOIN customers cst ON cst.id = l.customer_id
        WHERE l.stripe_subscription_id = ?
          AND l.contact_type = 'email'
        ORDER BY l.updated_at DESC, l.id DESC
        LIMIT 1
      `,
    )
    .bind(subscriptionId)
    .first<InvoiceLicenseRow>();
}

export async function sendStripeInvoicePaymentActionRequiredNotification(c: BillingNotificationContext, input: { subscriptionId: string; invoice: StripeInvoiceLike }) {
  const invoiceId = getString(input.invoice.id);
  if (!invoiceId) return false;
  const ctaUrl = invoiceHostedUrl(input.invoice);
  if (!ctaUrl) {
    throw new Error(`Invoice ${invoiceId} does not have hosted_invoice_url`);
  }
  const license = await getInvoiceLicenseBySubscription(c, input.subscriptionId);
  if (!license) return false;

  return sendOnce(c, {
    licenseId: license.id,
    customerId: license.customer_id,
    provider: PROVIDER_STRIPE,
    notificationType: "payment_action_required",
    dedupeKey: `payment_action_required:invoice:${invoiceId}`,
    email: license.contact,
    name: license.name,
    ctaUrl,
    invoiceAmount: invoiceAmount(input.invoice),
    licenseKey: license.license_key,
  });
}

export async function sendStripeInvoicePaymentFailedNotification(
  c: BillingNotificationContext,
  input: { subscriptionId: string; invoice: StripeInvoiceLike; origin?: string },
) {
  const invoiceId = getString(input.invoice.id);
  if (!invoiceId) return false;
  const license = await getInvoiceLicenseBySubscription(c, input.subscriptionId);
  if (!license) return false;
  const origin = input.origin || publicOriginFromEnv(c.env);

  return sendOnce(c, {
    licenseId: license.id,
    customerId: license.customer_id,
    provider: PROVIDER_STRIPE,
    notificationType: "payment_failed",
    dedupeKey: `payment_failed:invoice:${invoiceId}`,
    email: license.contact,
    name: license.name,
    ctaUrl: publicAccessUrl(origin),
    invoiceAmount: invoiceAmount(input.invoice),
    licenseKey: license.license_key,
  });
}

async function listExpirationReminderCandidates(c: BillingNotificationContext, now: Date) {
  const slots = slotsAt(now).filter((slot) => slot.kind === "reminder");
  if (!slots.length) return { results: [] as BillingLicenseRow[] };
  const dates = slots.map((slot) => localDateAtOffset(now, slot.days));
  return c.env.merlin_db
    .prepare(
      `
        SELECT l.id, l.customer_id, l.license_key, l.name, l.contact, l.expires_at,
               l.access_type, l.billing_status, l.stripe_customer_id, l.stripe_subscription_id,
               l.billing_cancel_at_period_end,
               s.status AS subscription_status,
               s.cancel_at_period_end AS subscription_cancel_at_period_end,
               cst.stripe_customer_id AS customer_stripe_customer_id
        FROM licenses l
        LEFT JOIN subscriptions s ON s.license_id = l.id
        LEFT JOIN customers cst ON cst.id = l.customer_id
        WHERE l.status = 'active'
          AND l.contact_type = 'email'
          AND COALESCE(l.access_type, 'free') IN ('monthly_subscription', 'annual_subscription', 'annual_manual')
          AND date(l.expires_at, '-3 hours') IN (${dates.map(() => "?").join(", ")})
          AND datetime(l.expires_at) > datetime(?)
          AND datetime(l.expires_at) <= datetime(?)
          AND NOT (
            l.stripe_subscription_id IS NOT NULL
            AND COALESCE(l.billing_cancel_at_period_end, 0) = 0
            AND COALESCE(s.cancel_at_period_end, 0) = 0
            AND COALESCE(s.status, l.billing_status, '') IN ('active', 'trialing')
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_sessions cs
            WHERE cs.provider = 'mercadopago'
              AND cs.scheduled_renewal_license_id = l.id
              AND cs.payment_status = 'paid'
              AND cs.renewal_applied_at IS NULL
          )
        ORDER BY datetime(l.expires_at) ASC
        LIMIT ?
      `,
    )
    .bind(...dates, now.toISOString(), addDays(now, REMINDER_WINDOW_DAYS).toISOString(), CRON_LIMIT)
    .all<BillingLicenseRow>();
}

export async function getExpirationReminderEligibility(
  c: BillingNotificationContext,
  licenseId: number,
  now = new Date(),
) {
  const end = addDays(now, REMINDER_WINDOW_DAYS).toISOString();
  const license = await c.env.merlin_db
    .prepare(
      `
        SELECT l.id, l.customer_id, l.license_key, l.name, l.contact, l.expires_at,
               l.access_type, l.billing_status, l.stripe_customer_id, l.stripe_subscription_id,
               l.billing_cancel_at_period_end,
               s.status AS subscription_status,
               s.cancel_at_period_end AS subscription_cancel_at_period_end,
               cst.stripe_customer_id AS customer_stripe_customer_id
        FROM licenses l
        LEFT JOIN subscriptions s ON s.license_id = l.id
        LEFT JOIN customers cst ON cst.id = l.customer_id
        WHERE l.id = ?
          AND l.status = 'active'
          AND l.contact_type = 'email'
          AND COALESCE(l.access_type, 'free') IN ('monthly_subscription', 'annual_subscription', 'annual_manual')
          AND datetime(l.expires_at) > datetime(?)
          AND datetime(l.expires_at) <= datetime(?)
          AND NOT (
            l.stripe_subscription_id IS NOT NULL
            AND COALESCE(l.billing_cancel_at_period_end, 0) = 0
            AND COALESCE(s.cancel_at_period_end, 0) = 0
            AND COALESCE(s.status, l.billing_status, '') IN ('active', 'trialing')
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_sessions cs
            WHERE cs.provider = 'mercadopago'
              AND cs.scheduled_renewal_license_id = l.id
              AND cs.payment_status = 'paid'
              AND cs.renewal_applied_at IS NULL
          )
        LIMIT 1
      `,
    )
    .bind(licenseId, now.toISOString(), end)
    .first<BillingLicenseRow>();

  if (!license) return { eligible: false as const, reason: "Licença fora da janela de aviso." };

  const dedupeKey = `expiration_reminder:license:${license.id}:expires:${dateOnly(license.expires_at)}`;
  const notification = await c.env.merlin_db
    .prepare("SELECT status FROM billing_notifications WHERE dedupe_key = ? LIMIT 1")
    .bind(dedupeKey)
    .first<{ status: string }>();

  if (notification?.status === "sent" || notification?.status === "pending") {
    return { eligible: false as const, reason: "Aviso já enviado para este vencimento." };
  }

  const today = localDateAtOffset(now, 0);
  const sameDay = await c.env.merlin_db
    .prepare(`SELECT id FROM billing_notifications WHERE license_id = ? AND notification_type IN ('manual_expiration_reminder', 'stripe_cancel_expiration_reminder') AND status = 'sent' AND date(sent_at, '-3 hours') = ? LIMIT 1`)
    .bind(license.id, today)
    .first<BillingNotificationRow>();
  if (sameDay) return { eligible: false as const, reason: "Aviso já enviado hoje para esta licença." };

  const sentCount = await c.env.merlin_db
    .prepare("SELECT COUNT(*) AS count FROM billing_notifications WHERE license_id = ? AND status = 'sent' AND dedupe_key LIKE ?")
    .bind(license.id, `${dedupeKey}%`)
    .first<{ count: number }>();
  if ((sentCount?.count || 0) >= 4) {
    return { eligible: false as const, reason: "Os quatro avisos deste vencimento já foram enviados." };
  }

  return { eligible: true as const, license };
}

export async function sendExpirationReminderForLicense(c: BillingNotificationContext, licenseId: number) {
  const eligibility = await getExpirationReminderEligibility(c, licenseId);
  if (!eligibility.eligible) return { ...eligibility, sent: false as const };

  const sent = await sendExpirationReminder(c, eligibility.license, publicOriginFromEnv(c.env));
  return { eligible: true as const, sent, license: eligibility.license };
}

async function listExpiredAccessCandidates(c: BillingNotificationContext, now: Date) {
  const slots = slotsAt(now).filter((slot) => slot.kind === "expired");
  if (!slots.length) return { results: [] as BillingLicenseRow[] };
  const dates = slots.map((slot) => localDateAtOffset(now, slot.days));
  return c.env.merlin_db
    .prepare(
      `
        SELECT l.id, l.customer_id, l.license_key, l.name, l.contact, l.expires_at,
               l.access_type, l.billing_status, l.stripe_customer_id, l.stripe_subscription_id,
               l.billing_cancel_at_period_end,
               s.status AS subscription_status,
               s.cancel_at_period_end AS subscription_cancel_at_period_end,
               cst.stripe_customer_id AS customer_stripe_customer_id
        FROM licenses l
        LEFT JOIN subscriptions s ON s.license_id = l.id
        LEFT JOIN customers cst ON cst.id = l.customer_id
        WHERE l.status IN ('active', 'expired')
          AND l.contact_type = 'email'
          AND COALESCE(l.access_type, 'free') IN ('monthly_subscription', 'annual_subscription', 'annual_manual')
          AND date(l.expires_at, '-3 hours') IN (${dates.map(() => "?").join(", ")})
          AND datetime(l.expires_at) < datetime(?)
          AND NOT (
            l.stripe_subscription_id IS NOT NULL
            AND COALESCE(l.billing_cancel_at_period_end, 0) = 0
            AND COALESCE(s.cancel_at_period_end, 0) = 0
            AND COALESCE(s.status, l.billing_status, '') IN ('active', 'trialing')
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_sessions cs
            WHERE cs.provider = 'mercadopago'
              AND cs.scheduled_renewal_license_id = l.id
              AND cs.payment_status = 'paid'
              AND cs.renewal_applied_at IS NULL
          )
        ORDER BY datetime(l.expires_at) ASC
        LIMIT ?
      `,
    )
    .bind(...dates, now.toISOString(), CRON_LIMIT)
    .all<BillingLicenseRow>();
}

function isStripeCancelAtPeriodEnd(row: BillingLicenseRow) {
  return Boolean(row.stripe_subscription_id)
    && Boolean(row.billing_cancel_at_period_end || row.subscription_cancel_at_period_end);
}

function providerForManualRow(row: BillingLicenseRow) {
  if (row.stripe_subscription_id) return PROVIDER_STRIPE;
  if ((row.billing_status || "").includes("pix")) return PROVIDER_MERCADO_PAGO;
  return row.customer_id ? PROVIDER_MERCADO_PAGO : PROVIDER_MANUAL;
}

async function replacedByLegacyEmail(c: BillingNotificationContext, row: BillingLicenseRow, slot: ReminderSlot) {
  const prefix = slot.kind === "reminder" ? "expiration_reminder" : "access_expired";
  const legacy = await c.env.merlin_db
    .prepare("SELECT sent_at FROM billing_notifications WHERE dedupe_key = ? AND status = 'sent' LIMIT 1")
    .bind(`${prefix}:license:${row.id}:expires:${dateOnly(row.expires_at)}`)
    .first<{ sent_at: string | null }>();
  if (!legacy?.sent_at) return false;
  const legacyDays = localDayNumber(new Date(row.expires_at)) - localDayNumber(new Date(legacy.sent_at));
  if (slot.kind === "expired") {
    return legacyDays === slot.days || (slot.days === -1 && legacyDays === 0);
  }
  const previous = slot.days === 1 ? 2 : slot.days === 2 ? 4 : slot.days === 4 ? 7 : 8;
  return legacyDays >= slot.days && legacyDays < previous;
}

async function sendExpirationReminder(c: BillingNotificationContext, row: BillingLicenseRow, origin: string, slot?: ReminderSlot) {
  const suffix = slot ? `:${slot.code}` : "";
  if (isStripeCancelAtPeriodEnd(row)) {
    return sendOnce(c, {
      licenseId: row.id,
      customerId: row.customer_id,
      provider: PROVIDER_STRIPE,
      notificationType: "stripe_cancel_expiration_reminder",
      dedupeKey: `expiration_reminder:license:${row.id}:expires:${dateOnly(row.expires_at)}${suffix}`,
      email: row.contact,
      name: row.name,
      ctaUrl: publicAccessUrl(origin),
      expiresAt: row.expires_at,
      daysUntilExpiry: slot?.days,
      licenseKey: row.license_key,
    });
  }

  return sendOnce(c, {
    licenseId: row.id,
    customerId: row.customer_id,
    provider: providerForManualRow(row),
    notificationType: "manual_expiration_reminder",
    dedupeKey: `expiration_reminder:license:${row.id}:expires:${dateOnly(row.expires_at)}${suffix}`,
    email: row.contact,
    name: row.name,
    ctaUrl: publicAccessUrl(origin),
    expiresAt: row.expires_at,
    daysUntilExpiry: slot?.days,
    licenseKey: row.license_key,
  });
}

async function sendAccessExpired(c: BillingNotificationContext, row: BillingLicenseRow, origin: string, slot: ReminderSlot) {
  return sendOnce(c, {
    licenseId: row.id,
    customerId: row.customer_id,
    provider: row.stripe_subscription_id ? PROVIDER_STRIPE : providerForManualRow(row),
    notificationType: "access_expired",
    dedupeKey: `access_expired:license:${row.id}:expires:${dateOnly(row.expires_at)}:${slot.code}`,
    email: row.contact,
    name: row.name,
    ctaUrl: publicAccessUrl(origin),
    expiresAt: row.expires_at,
    daysSinceExpiry: Math.abs(slot.days),
    licenseKey: row.license_key,
  });
}

export async function runBillingNotificationCron(env: AppBindings, now = new Date()) {
  const c = { env };
  const origin = publicOriginFromEnv(env);
  const summary = {
    expirationCandidates: 0,
    expirationSent: 0,
    expiredCandidates: 0,
    expiredSent: 0,
  };

  const reminderRows = (await listExpirationReminderCandidates(c, now)).results || [];
  summary.expirationCandidates = reminderRows.length;
  for (const row of reminderRows) {
    try {
      const slot = slotForExpiry(now, row.expires_at, "reminder");
      if (!slot || await replacedByLegacyEmail(c, row, slot)) continue;
      if (await sendExpirationReminder(c, row, origin, slot)) summary.expirationSent += 1;
    } catch (error) {
      console.warn("[billing-notifications] expiration reminder failed", row.id, error instanceof Error ? error.message : error);
    }
  }

  const expiredRows = (await listExpiredAccessCandidates(c, now)).results || [];
  summary.expiredCandidates = expiredRows.length;
  for (const row of expiredRows) {
    try {
      const slot = slotForExpiry(now, row.expires_at, "expired");
      if (!slot || await replacedByLegacyEmail(c, row, slot)) continue;
      if (await sendAccessExpired(c, row, origin, slot)) summary.expiredSent += 1;
    } catch (error) {
      console.warn("[billing-notifications] access expired email failed", row.id, error instanceof Error ? error.message : error);
    }
  }

  console.info("[billing-notifications] cron completed", summary);
  return summary;
}
