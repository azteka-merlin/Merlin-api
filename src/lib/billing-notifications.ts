import type { AppBindings } from "../types";
import { sendBillingEmail, type BillingEmailKind } from "./billing-emails";

const PROVIDER_STRIPE = "stripe";
const PROVIDER_MERCADO_PAGO = "mercadopago";
const PROVIDER_MANUAL = "manual";
const REMINDER_WINDOW_START_DAYS = 2;
const REMINDER_WINDOW_END_DAYS = 4;
const EXPIRED_LOOKBACK_DAYS = 2;
const CRON_LIMIT = 200;

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
  await c.env.merlin_db
    .prepare(
      `
        INSERT OR IGNORE INTO billing_notifications (
          license_id, customer_id, provider, notification_type, dedupe_key, email, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
    )
    .run();

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
      expiresAt: input.expiresAt ? dateOnly(input.expiresAt) : null,
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
  const start = addDays(now, REMINDER_WINDOW_START_DAYS).toISOString();
  const end = addDays(now, REMINDER_WINDOW_END_DAYS).toISOString();
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
          AND COALESCE(l.access_type, 'free') = 'monthly_subscription'
          AND datetime(l.expires_at) BETWEEN datetime(?) AND datetime(?)
          AND NOT (
            l.stripe_subscription_id IS NOT NULL
            AND COALESCE(l.billing_cancel_at_period_end, 0) = 0
            AND COALESCE(s.cancel_at_period_end, 0) = 0
            AND COALESCE(s.status, l.billing_status, '') IN ('active', 'trialing')
          )
        ORDER BY datetime(l.expires_at) ASC
        LIMIT ?
      `,
    )
    .bind(start, end, CRON_LIMIT)
    .all<BillingLicenseRow>();
}

async function listExpiredAccessCandidates(c: BillingNotificationContext, now: Date) {
  const start = addDays(now, -EXPIRED_LOOKBACK_DAYS).toISOString();
  const end = now.toISOString();
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
          AND COALESCE(l.access_type, 'free') = 'monthly_subscription'
          AND datetime(l.expires_at) >= datetime(?)
          AND datetime(l.expires_at) < datetime(?)
          AND NOT (
            l.stripe_subscription_id IS NOT NULL
            AND COALESCE(l.billing_cancel_at_period_end, 0) = 0
            AND COALESCE(s.cancel_at_period_end, 0) = 0
            AND COALESCE(s.status, l.billing_status, '') IN ('active', 'trialing')
          )
        ORDER BY datetime(l.expires_at) ASC
        LIMIT ?
      `,
    )
    .bind(start, end, CRON_LIMIT)
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

async function sendExpirationReminder(c: BillingNotificationContext, row: BillingLicenseRow, origin: string) {
  if (isStripeCancelAtPeriodEnd(row)) {
    return sendOnce(c, {
      licenseId: row.id,
      customerId: row.customer_id,
      provider: PROVIDER_STRIPE,
      notificationType: "stripe_cancel_expiration_reminder",
      dedupeKey: `expiration_reminder:license:${row.id}:expires:${dateOnly(row.expires_at)}`,
      email: row.contact,
      name: row.name,
      ctaUrl: publicAccessUrl(origin),
      expiresAt: row.expires_at,
      licenseKey: row.license_key,
    });
  }

  return sendOnce(c, {
    licenseId: row.id,
    customerId: row.customer_id,
    provider: providerForManualRow(row),
    notificationType: "manual_expiration_reminder",
    dedupeKey: `expiration_reminder:license:${row.id}:expires:${dateOnly(row.expires_at)}`,
    email: row.contact,
    name: row.name,
    ctaUrl: publicAccessUrl(origin),
    expiresAt: row.expires_at,
    licenseKey: row.license_key,
  });
}

async function sendAccessExpired(c: BillingNotificationContext, row: BillingLicenseRow, origin: string) {
  return sendOnce(c, {
    licenseId: row.id,
    customerId: row.customer_id,
    provider: row.stripe_subscription_id ? PROVIDER_STRIPE : providerForManualRow(row),
    notificationType: "access_expired",
    dedupeKey: `access_expired:license:${row.id}:expires:${dateOnly(row.expires_at)}`,
    email: row.contact,
    name: row.name,
    ctaUrl: publicAccessUrl(origin),
    expiresAt: row.expires_at,
    licenseKey: row.license_key,
  });
}

export async function runBillingNotificationCron(env: AppBindings) {
  const c = { env };
  const now = new Date();
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
      if (await sendExpirationReminder(c, row, origin)) summary.expirationSent += 1;
    } catch (error) {
      console.warn("[billing-notifications] expiration reminder failed", row.id, error instanceof Error ? error.message : error);
    }
  }

  const expiredRows = (await listExpiredAccessCandidates(c, now)).results || [];
  summary.expiredCandidates = expiredRows.length;
  for (const row of expiredRows) {
    try {
      if (await sendAccessExpired(c, row, origin)) summary.expiredSent += 1;
    } catch (error) {
      console.warn("[billing-notifications] access expired email failed", row.id, error instanceof Error ? error.message : error);
    }
  }

  console.info("[billing-notifications] cron completed", summary);
  return summary;
}
