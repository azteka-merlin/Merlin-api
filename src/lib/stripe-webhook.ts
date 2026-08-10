import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";
import { sendWelcomeAccessKeyEmail } from "./access-key-emails";
import { sendStripeInvoicePaymentActionRequiredNotification, sendStripeInvoicePaymentFailedNotification } from "./billing-notifications";
import { assertRecentPublicEmailVerification } from "./email-verification";
import { LIFETIME_EXPIRES_AT, UPGRADE_OPERATION } from "./public-access-management";

const PROVIDER_STRIPE = "stripe";
const SIGNATURE_TOLERANCE_SECONDS = 300;

type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
};

type CheckoutRow = {
  id: number;
  customer_id: number;
  provider_session_id: string;
  provider_price_id: string;
  provider_subscription_id: string | null;
  plan_type: "monthly" | "lifetime";
  mode: "subscription" | "payment";
  status: string;
  payment_status: string | null;
  license_id: number | null;
  reactivation_license_id: number | null;
  operation_type: string | null;
  upgrade_license_id: number | null;
  upgrade_subscription_id: string | null;
  upgrade_processed_at: string | null;
  pending_license_key: string | null;
  pending_name: string | null;
  pending_recovery_pin_hash: string | null;
  pending_recovery_notice_accepted_at: string | null;
  checkout_evidence_json: string | null;
};

type CustomerRow = {
  id: number;
  email: string;
  email_normalized: string;
  stripe_customer_id: string | null;
};

type LicenseRow = {
  id: number;
  license_key: string;
  name: string;
  contact: string;
  expires_at: string;
  status: string;
  access_type?: string | null;
  customer_id?: number | null;
  stripe_subscription_id?: string | null;
};

type StripeCharge = {
  id: string;
  object: "charge";
  customer?: string | Record<string, unknown> | null;
  invoice?: string | Record<string, unknown> | null;
  payment_intent?: string | Record<string, unknown> | null;
};

type SubscriptionRow = {
  id: number;
  provider_subscription_id: string;
};

type StripeSubscription = {
  id: string;
  object: "subscription";
  status?: string;
  current_period_end?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
};

function getWebhookSecret(c: AppContext) {
  const secret = String(c.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    throw new HTTPException(503, { message: "Stripe webhook nao esta configurado neste ambiente." });
  }
  return secret;
}

function getStripeSecretKey(c: AppContext) {
  const secret = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!secret) {
    throw new HTTPException(503, { message: "Stripe nao esta configurado neste ambiente." });
  }
  return secret;
}

function stripeApiError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }
  return fallback;
}

function encodeBasicAuth(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

async function stripeGet<T>(c: AppContext, path: string) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: {
      Authorization: encodeBasicAuth(getStripeSecretKey(c)),
    },
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel consultar a Stripe.") });
  }
  return payload;
}

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: encodeBasicAuth(getStripeSecretKey(c)),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel atualizar a Stripe.") });
  }
  return payload;
}

async function configureStripeSubscriptionForRenewals(c: AppContext, subscriptionId: string | null) {
  if (!subscriptionId) {
    return;
  }

  const params = new URLSearchParams();
  params.set("payment_settings[payment_method_types][0]", "card");
  params.set("payment_settings[payment_method_options][card][request_three_d_secure]", "automatic");
  params.set("payment_settings[save_default_payment_method]", "on_subscription");

  try {
    await stripePost<Record<string, unknown>>(c, `/subscriptions/${encodeURIComponent(subscriptionId)}`, params);
  } catch (error) {
    console.warn(
      "[stripe-webhook] could not configure subscription renewal settings",
      subscriptionId,
      error instanceof Error ? error.message : error,
    );
  }
}

function parseStripeSignature(header: string | null) {
  const parts = String(header || "").split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) || "";
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))
    .filter(Boolean);
  return { timestamp, signatures };
}

function timingSafeEqualHex(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function parseAndVerifyStripeWebhook(c: AppContext, rawBody: string) {
  const { timestamp, signatures } = parseStripeSignature(c.req.raw.headers.get("stripe-signature"));
  const timestampSeconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampSeconds) || signatures.length === 0) {
    throw new HTTPException(400, { message: "Assinatura Stripe ausente ou invalida." });
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    throw new HTTPException(400, { message: "Assinatura Stripe expirada." });
  }

  const expected = await hmacSha256Hex(getWebhookSecret(c), `${timestamp}.${rawBody}`);
  const valid = signatures.some((signature) => timingSafeEqualHex(signature, expected));
  if (!valid) {
    throw new HTTPException(400, { message: "Assinatura Stripe invalida." });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new HTTPException(400, { message: "Payload Stripe invalido." });
  }

  if (!event.id || !event.type || !event.data?.object) {
    throw new HTTPException(400, { message: "Evento Stripe invalido." });
  }

  return event;
}

async function reservePaymentEvent(c: AppContext, event: StripeEvent) {
  const now = new Date().toISOString();
  try {
    await c.env.merlin_db
      .prepare(
        `
          INSERT INTO payment_events (provider, provider_event_id, event_type, raw_created_at, processing_status, created_at)
          VALUES (?, ?, ?, ?, 'processing', ?)
        `,
      )
      .bind(PROVIDER_STRIPE, event.id, event.type, event.created ? new Date(event.created * 1000).toISOString() : null, now)
      .run();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("idx_payment_events_provider_event") || message.toLowerCase().includes("unique")) {
      return false;
    }
    throw error;
  }
}

async function markPaymentEvent(c: AppContext, eventId: string, status: "processed" | "ignored" | "failed", errorMessage?: string) {
  await c.env.merlin_db
    .prepare(
      `
        UPDATE payment_events
        SET processing_status = ?, processed_at = ?, error_message = ?
        WHERE provider = ?
          AND provider_event_id = ?
      `,
    )
    .bind(status, new Date().toISOString(), errorMessage ? errorMessage.slice(0, 500) : null, PROVIDER_STRIPE, eventId)
    .run();
}

function getString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function getNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getStripeId(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  const object = getObject(value);
  return getString(object?.id);
}

function unixToIso(value: unknown) {
  const seconds = getNumber(value);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function dateOrLifetime(value: string | null) {
  return value || LIFETIME_EXPIRES_AT;
}

function getSubscriptionEffectivePeriodEnd(subscription: Pick<StripeSubscription, "current_period_end" | "cancel_at">) {
  return unixToIso(subscription.current_period_end) || unixToIso(subscription.cancel_at);
}

function requestOrigin(c: AppContext) {
  const url = new URL(c.req.raw.url);
  return `${url.protocol}//${url.host}`;
}

function isSubscriptionCancelScheduled(subscription: Pick<StripeSubscription, "cancel_at_period_end" | "cancel_at">) {
  return Boolean(subscription.cancel_at_period_end) || Boolean(subscription.cancel_at);
}

function oneMonthFromNowIso() {
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

function daysFromNowIso(days: number) {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function getCheckoutCardTrialDays(checkout: CheckoutRow) {
  if (!checkout.checkout_evidence_json) {
    return null;
  }
  try {
    const evidence = JSON.parse(checkout.checkout_evidence_json) as { cardTrialDays?: unknown };
    const value = Number(evidence.cardTrialDays);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.min(730, Math.max(1, Math.floor(value)));
  } catch {
    return null;
  }
}

async function getCheckoutBySessionId(c: AppContext, sessionId: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, customer_id, provider_session_id, provider_price_id, provider_subscription_id, plan_type, mode, status, payment_status, license_id, reactivation_license_id,
          operation_type, upgrade_license_id, upgrade_subscription_id, upgrade_processed_at,
          pending_license_key, pending_name, pending_recovery_pin_hash, pending_recovery_notice_accepted_at, checkout_evidence_json
        FROM checkout_sessions
        WHERE provider = ?
          AND provider_session_id = ?
        LIMIT 1
      `,
    )
    .bind(PROVIDER_STRIPE, sessionId)
    .first<CheckoutRow>();
}

async function getCheckoutBySubscriptionId(c: AppContext, subscriptionId: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, customer_id, provider_session_id, provider_price_id, provider_subscription_id, plan_type, mode, status, payment_status, license_id, reactivation_license_id,
          operation_type, upgrade_license_id, upgrade_subscription_id, upgrade_processed_at,
          pending_license_key, pending_name, pending_recovery_pin_hash, pending_recovery_notice_accepted_at, checkout_evidence_json
        FROM checkout_sessions
        WHERE provider = ?
          AND provider_subscription_id = ?
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(PROVIDER_STRIPE, subscriptionId)
    .first<CheckoutRow>();
}

async function getLatestCheckoutByEmail(c: AppContext, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT cs.id, cs.customer_id, cs.provider_session_id, cs.provider_price_id, cs.provider_subscription_id, cs.plan_type, cs.mode, cs.status, cs.payment_status, cs.license_id, cs.reactivation_license_id,
          cs.operation_type, cs.upgrade_license_id, cs.upgrade_subscription_id, cs.upgrade_processed_at,
          cs.pending_license_key, cs.pending_name, cs.pending_recovery_pin_hash, cs.pending_recovery_notice_accepted_at, cs.checkout_evidence_json
        FROM checkout_sessions cs
        JOIN customers cst ON cst.id = cs.customer_id
        WHERE cs.provider = ?
          AND cst.email_normalized = ?
        ORDER BY cs.id DESC
        LIMIT 1
      `,
    )
    .bind(PROVIDER_STRIPE, emailNormalized)
    .first<CheckoutRow>();
}

async function getCustomer(c: AppContext, customerId: number) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, email, email_normalized, stripe_customer_id
        FROM customers
        WHERE id = ?
      `,
    )
    .bind(customerId)
    .first<CustomerRow>();
}

async function getLicenseById(c: AppContext, licenseId: number) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, expires_at, status
        FROM licenses
        WHERE id = ?
      `,
    )
    .bind(licenseId)
    .first<LicenseRow>();
}

async function getActiveLicenseByEmail(c: AppContext, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, expires_at, status
        FROM licenses
        WHERE contact_type = 'email'
          AND lower(contact) = ?
          AND status = 'active'
          AND datetime(expires_at) >= datetime('now')
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(emailNormalized)
    .first<LicenseRow>();
}

async function activateLicenseFromCheckout(
  c: AppContext,
  checkout: CheckoutRow,
  input: {
    accessType: "paid_lifetime" | "monthly_subscription";
    billingStatus: "active" | "past_due" | "canceled" | "expired";
    expiresAt: string;
    stripeCustomerId: string | null;
    subscriptionId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd?: boolean;
    checkoutPaymentStatus?: string;
  },
) {
  if (checkout.license_id) {
    const existing = await getLicenseById(c, checkout.license_id);
    if (existing) {
      return existing;
    }
  }

  const customer = await getCustomer(c, checkout.customer_id);
  if (!customer) {
    throw new Error(`Customer ${checkout.customer_id} not found for checkout ${checkout.provider_session_id}`);
  }

  if (checkout.reactivation_license_id) {
    const existing = await getLicenseById(c, checkout.reactivation_license_id);
    if (!existing) {
      throw new Error(`Reactivation license ${checkout.reactivation_license_id} not found`);
    }
    if (!checkout.pending_name || !checkout.pending_recovery_pin_hash) {
      throw new Error(`Checkout ${checkout.provider_session_id} is missing pending reactivation data`);
    }
    const now = new Date().toISOString();
    await c.env.merlin_db
      .prepare(
        `
          UPDATE licenses
          SET name = ?,
              recovery_pin_hash = ?,
              recovery_notice_accepted_at = ?,
              hwid = NULL,
              expires_at = ?,
              status = 'active',
              revoked_reason = NULL,
              revoked_origin = NULL,
              revoked_event_id = NULL,
              source = 'stripe',
              customer_id = ?,
              access_type = ?,
              billing_status = ?,
              stripe_customer_id = ?,
              stripe_subscription_id = ?,
              stripe_checkout_session_id = ?,
              billing_current_period_end = ?,
              billing_cancel_at_period_end = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        checkout.pending_name,
        checkout.pending_recovery_pin_hash,
        checkout.pending_recovery_notice_accepted_at || now,
        input.expiresAt,
        customer.id,
        input.accessType,
        input.billingStatus,
        input.stripeCustomerId || customer.stripe_customer_id,
        input.subscriptionId,
        checkout.provider_session_id,
        input.currentPeriodEnd,
        input.cancelAtPeriodEnd ? 1 : 0,
        now,
        existing.id,
      )
      .run();

    await c.env.merlin_db
      .prepare(
        `
          UPDATE checkout_sessions
          SET license_id = ?, status = 'completed', completed_at = ?, provider_subscription_id = COALESCE(?, provider_subscription_id), payment_status = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(existing.id, now, input.subscriptionId, input.checkoutPaymentStatus || "paid", now, checkout.id)
      .run();

    const updated = await getLicenseById(c, existing.id);
    if (!updated) {
      throw new Error(`Reactivated license ${existing.id} not found`);
    }
    c.executionCtx.waitUntil(sendWelcomeAccessKeyEmail(c, {
      email: customer.email_normalized || customer.email,
      name: updated.name,
      licenseKey: updated.license_key,
    }).catch((error) => {
      console.warn("[stripe-webhook] welcome email failed", error instanceof Error ? error.message : error);
    }));
    return updated;
  }

  if (!checkout.pending_license_key || !checkout.pending_name || !checkout.pending_recovery_pin_hash) {
    throw new Error(`Checkout ${checkout.provider_session_id} is missing pending license data`);
  }

  const now = new Date().toISOString();
  let createdId: number | null = null;
  try {
    const result = await c.env.merlin_db
      .prepare(
        `
          INSERT INTO licenses (
            license_key, name, contact, contact_type, source, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status,
            revoked_reason, created_at, updated_at, customer_id, access_type, billing_status, stripe_customer_id, stripe_subscription_id,
            stripe_checkout_session_id, billing_current_period_end, billing_cancel_at_period_end
          )
          VALUES (?, ?, ?, 'email', 'stripe', ?, ?, NULL, ?, 'active',
            NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        checkout.pending_license_key,
        checkout.pending_name,
        customer.email_normalized || customer.email,
        checkout.pending_recovery_pin_hash,
        checkout.pending_recovery_notice_accepted_at || now,
        input.expiresAt,
        now,
        now,
        customer.id,
        input.accessType,
        input.billingStatus,
        input.stripeCustomerId || customer.stripe_customer_id,
        input.subscriptionId,
        checkout.provider_session_id,
        input.currentPeriodEnd,
        input.cancelAtPeriodEnd ? 1 : 0,
      )
      .run();
    createdId = Number(result.meta.last_row_id);
  } catch (error) {
    const existing = await c.env.merlin_db
      .prepare(`SELECT id, license_key, name, contact, expires_at, status FROM licenses WHERE contact_type = 'email' AND lower(contact) = ? LIMIT 1`)
      .bind(customer.email_normalized)
      .first<LicenseRow>();
    if (existing) {
      createdId = existing.id;
    } else {
      throw error;
    }
  }

  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET license_id = ?, status = 'completed', completed_at = ?, provider_subscription_id = COALESCE(?, provider_subscription_id), payment_status = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(createdId, now, input.subscriptionId, input.checkoutPaymentStatus || "paid", now, checkout.id)
    .run();

  const license = await getLicenseById(c, createdId);
  if (!license) {
    throw new Error(`Created license ${createdId} not found`);
  }

  c.executionCtx.waitUntil(sendWelcomeAccessKeyEmail(c, {
    email: customer.email_normalized || customer.email,
    name: license.name,
    licenseKey: license.license_key,
  }).catch((error) => {
    console.warn("[stripe-webhook] welcome email failed", error instanceof Error ? error.message : error);
  }));

  return license;
}

async function saveSubscription(
  c: AppContext,
  input: {
    customerId: number;
    licenseId: number;
    subscriptionId: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  },
) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO subscriptions (
          customer_id, license_id, provider, provider_subscription_id, status, current_period_end, cancel_at_period_end, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(customer_id) DO UPDATE SET
          license_id = excluded.license_id,
          provider = excluded.provider,
          provider_subscription_id = excluded.provider_subscription_id,
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          updated_at = excluded.updated_at
      `,
    )
    .bind(input.customerId, input.licenseId, PROVIDER_STRIPE, input.subscriptionId, input.status, input.currentPeriodEnd, input.cancelAtPeriodEnd ? 1 : 0, now, now)
    .run();
}

async function getRenewingSubscriptionsForCustomer(c: AppContext, customerId: number) {
  const result = await c.env.merlin_db
    .prepare(
      `
        SELECT id, provider_subscription_id
        FROM subscriptions
        WHERE customer_id = ?
          AND provider = ?
          AND provider_subscription_id IS NOT NULL
          AND status IN ('active', 'past_due', 'dispute_open')
          AND cancel_at_period_end = 0
      `,
    )
    .bind(customerId, PROVIDER_STRIPE)
    .all<SubscriptionRow>();

  return result.results || [];
}

async function cancelCustomerSubscriptionsAtPeriodEnd(c: AppContext, customerId: number) {
  const subscriptions = await getRenewingSubscriptionsForCustomer(c, customerId);
  const now = new Date().toISOString();

  for (const subscription of subscriptions) {
    const params = new URLSearchParams();
    params.set("cancel_at_period_end", "true");
    const updated = await stripePost<StripeSubscription>(
      c,
      `/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}`,
      params,
    );
    const currentPeriodEnd = getSubscriptionEffectivePeriodEnd(updated);
    const status = updated.status || "active";
    const cancelScheduled = isSubscriptionCancelScheduled(updated);

    await c.env.merlin_db
      .prepare(
        `
          UPDATE subscriptions
          SET status = ?,
              current_period_end = COALESCE(?, current_period_end),
              cancel_at_period_end = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(status, currentPeriodEnd, cancelScheduled ? 1 : 0, now, subscription.id)
      .run();
  }
}

async function savePayment(
  c: AppContext,
  input: {
    customerId: number;
    licenseId: number | null;
    paymentId: string | null;
    checkoutSessionId: string | null;
    subscriptionId: string | null;
    amountCents: number;
    currency: string;
    status: string;
    paymentType: "one_time" | "subscription";
  },
) {
  await c.env.merlin_db
    .prepare(
      `
        INSERT OR IGNORE INTO payments (
          customer_id, license_id, provider, provider_payment_id, provider_checkout_session_id, provider_subscription_id,
          amount_cents, currency, status, payment_type, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(input.customerId, input.licenseId, PROVIDER_STRIPE, input.paymentId, input.checkoutSessionId, input.subscriptionId, input.amountCents, input.currency, input.status, input.paymentType, new Date().toISOString())
    .run();
}

async function getUpgradeLicenseById(c: AppContext, licenseId: number) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, license_key, name, contact, expires_at, status, access_type, customer_id, stripe_subscription_id
        FROM licenses
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(licenseId)
    .first<LicenseRow>();
}

async function handleLifetimeUpgradeCheckoutCompleted(c: AppContext, checkout: CheckoutRow, session: Record<string, unknown>) {
  if (checkout.upgrade_processed_at) {
    return;
  }
  const upgradeLicenseId = checkout.upgrade_license_id || checkout.license_id;
  if (!upgradeLicenseId) {
    throw new Error(`Upgrade checkout ${checkout.provider_session_id} is missing upgrade license id`);
  }

  const license = await getUpgradeLicenseById(c, upgradeLicenseId);
  if (!license) {
    throw new Error(`Upgrade license ${upgradeLicenseId} not found`);
  }
  if (license.customer_id !== checkout.customer_id) {
    throw new Error(`Upgrade checkout ${checkout.provider_session_id} customer mismatch`);
  }

  const now = new Date().toISOString();
  if (license.access_type !== "paid_lifetime" && license.access_type !== "legacy_lifetime") {
    if (license.status !== "active" || license.access_type !== "monthly_subscription") {
      throw new Error(`License ${license.id} is not eligible for upgrade`);
    }

    await c.env.merlin_db
      .prepare(
        `
          UPDATE licenses
          SET access_type = 'paid_lifetime',
              billing_status = 'active',
              expires_at = ?,
              stripe_subscription_id = NULL,
              stripe_checkout_session_id = ?,
              billing_current_period_end = NULL,
              billing_cancel_at_period_end = 0,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(LIFETIME_EXPIRES_AT, checkout.provider_session_id, now, license.id)
      .run();
  }

  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET license_id = ?,
            status = 'completed',
            payment_status = 'paid',
            completed_at = COALESCE(completed_at, ?),
            upgrade_processed_at = COALESCE(upgrade_processed_at, ?),
            updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(license.id, now, now, now, checkout.id)
    .run();

  await savePayment(c, {
    customerId: checkout.customer_id,
    licenseId: license.id,
    paymentId: getStripeId(session.payment_intent) || getString(session.id),
    checkoutSessionId: checkout.provider_session_id,
    subscriptionId: null,
    amountCents: getNumber(session.amount_total) || 0,
    currency: getString(session.currency) || "brl",
    status: "paid",
    paymentType: "one_time",
  });

  try {
    await cancelCustomerSubscriptionsAtPeriodEnd(c, checkout.customer_id);
    await c.env.merlin_db
      .prepare(`UPDATE checkout_sessions SET upgrade_cancel_error = NULL, updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), checkout.id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown Stripe cancellation error");
    console.warn("[stripe-webhook] lifetime upgrade converted but subscription cancellation failed", {
      checkoutSessionId: checkout.provider_session_id,
      licenseId: license.id,
      message,
    });
    await c.env.merlin_db
      .prepare(`UPDATE checkout_sessions SET upgrade_cancel_error = ?, updated_at = ? WHERE id = ?`)
      .bind(message.slice(0, 500), new Date().toISOString(), checkout.id)
      .run();
  }
}

async function handleCheckoutCompleted(c: AppContext, session: Record<string, unknown>) {
  const sessionId = getString(session.id);
  if (!sessionId) {
    throw new Error("checkout.session.completed missing session id");
  }
  const checkout = await getCheckoutBySessionId(c, sessionId);
  if (!checkout) {
    return;
  }

  const subscriptionId = getStripeId(session.subscription);
  const paymentStatus = getString(session.payment_status) || null;
  const stripeCustomerId = getStripeId(session.customer);
  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET status = ?, payment_status = ?, provider_subscription_id = COALESCE(?, provider_subscription_id), completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(getString(session.status) || "complete", paymentStatus, subscriptionId, new Date().toISOString(), new Date().toISOString(), checkout.id)
    .run();

  if (checkout.operation_type === UPGRADE_OPERATION) {
    if (paymentStatus === "paid") {
      await handleLifetimeUpgradeCheckoutCompleted(c, checkout, session);
    }
    return;
  }

  if (checkout.plan_type === "lifetime" && paymentStatus === "paid") {
    const license = await activateLicenseFromCheckout(c, checkout, {
      accessType: "paid_lifetime",
      billingStatus: "active",
      expiresAt: LIFETIME_EXPIRES_AT,
      stripeCustomerId,
      subscriptionId: null,
      currentPeriodEnd: null,
    });
    await savePayment(c, {
      customerId: checkout.customer_id,
      licenseId: license.id,
      paymentId: getStripeId(session.payment_intent) || sessionId,
      checkoutSessionId: sessionId,
      subscriptionId: null,
      amountCents: getNumber(session.amount_total) || 0,
      currency: getString(session.currency) || "brl",
      status: "paid",
      paymentType: "one_time",
    });
    await cancelCustomerSubscriptionsAtPeriodEnd(c, checkout.customer_id);
  }

  if (checkout.plan_type === "monthly") {
    const cardTrialDays = getCheckoutCardTrialDays(checkout);
    const isPaid = paymentStatus === "paid";
    const isTrialCheckout = !isPaid && Boolean(subscriptionId) && Boolean(cardTrialDays);
    if (!isPaid && !isTrialCheckout) {
      return;
    }
    const periodEnd = isTrialCheckout ? daysFromNowIso(cardTrialDays || 30) : oneMonthFromNowIso();
    const checkoutPaymentStatus = isTrialCheckout ? "trialing" : "paid";
    const license = await activateLicenseFromCheckout(c, checkout, {
      accessType: "monthly_subscription",
      billingStatus: "active",
      expiresAt: dateOrLifetime(periodEnd),
      stripeCustomerId,
      subscriptionId,
      currentPeriodEnd: periodEnd,
      checkoutPaymentStatus,
    });
    await configureStripeSubscriptionForRenewals(c, subscriptionId);
    if (subscriptionId) {
      await saveSubscription(c, {
        customerId: checkout.customer_id,
        licenseId: license.id,
        subscriptionId,
        status: isTrialCheckout ? "trialing" : "active",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
    }
  }
}

async function handleCheckoutExpired(c: AppContext, session: Record<string, unknown>) {
  const sessionId = getString(session.id);
  if (!sessionId) {
    throw new Error("checkout.session.expired missing session id");
  }

  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET status = 'expired',
            payment_status = COALESCE(?, payment_status),
            provider_session_expires_at = COALESCE(?, provider_session_expires_at),
            updated_at = ?
        WHERE provider = ?
          AND provider_session_id = ?
          AND license_id IS NULL
      `,
    )
    .bind(getString(session.payment_status) || "unpaid", unixToIso(session.expires_at), new Date().toISOString(), PROVIDER_STRIPE, sessionId)
    .run();
}

function getInvoiceSubscriptionId(invoice: Record<string, unknown>) {
  return getStripeId(invoice.subscription)
    || getString(getObject(getObject(invoice.parent)?.subscription_details)?.subscription)
    || getString(getObject(invoice.subscription_details)?.subscription);
}

function getInvoicePeriodEnd(invoice: Record<string, unknown>) {
  const lines = getObject(invoice.lines);
  const lineItems = Array.isArray(lines?.data) ? lines.data : [];
  const firstLine = getObject(lineItems[0]);
  const period = getObject(firstLine?.period);
  return unixToIso(period?.end);
}

async function handleInvoicePaid(c: AppContext, invoice: Record<string, unknown>) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return;
  }
  const checkout = await getCheckoutBySubscriptionId(c, subscriptionId);
  if (!checkout) {
    return;
  }

  const periodEnd = getInvoicePeriodEnd(invoice);
  const expiresAt = dateOrLifetime(periodEnd);
  const stripeCustomerId = getStripeId(invoice.customer);
  const license = await activateLicenseFromCheckout(c, checkout, {
    accessType: "monthly_subscription",
    billingStatus: "active",
    expiresAt,
    stripeCustomerId,
    subscriptionId,
    currentPeriodEnd: periodEnd,
  });
  await configureStripeSubscriptionForRenewals(c, subscriptionId);

  await c.env.merlin_db
    .prepare(
      `
        UPDATE licenses
        SET expires_at = ?, billing_status = 'active', billing_current_period_end = ?, stripe_subscription_id = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(expiresAt, periodEnd, subscriptionId, new Date().toISOString(), license.id)
    .run();

  await saveSubscription(c, {
    customerId: checkout.customer_id,
    licenseId: license.id,
    subscriptionId,
    status: "active",
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
  });
  await savePayment(c, {
    customerId: checkout.customer_id,
    licenseId: license.id,
    paymentId: getString(invoice.id),
    checkoutSessionId: checkout.provider_session_id,
    subscriptionId,
    amountCents: getNumber(invoice.amount_paid) || getNumber(invoice.total) || 0,
    currency: getString(invoice.currency) || "brl",
    status: "paid",
    paymentType: "subscription",
  });
}

async function updateSubscriptionStatus(c: AppContext, subscription: Record<string, unknown>) {
  const subscriptionId = getString(subscription.id);
  if (!subscriptionId) {
    return;
  }
  const currentPeriodEnd = getSubscriptionEffectivePeriodEnd(subscription);
  const cancelAtPeriodEnd = isSubscriptionCancelScheduled(subscription);
  const status = getString(subscription.status) || "unknown";

  await c.env.merlin_db
    .prepare(
      `
        UPDATE subscriptions
        SET status = ?, current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?, updated_at = ?
        WHERE provider = ?
          AND provider_subscription_id = ?
      `,
    )
    .bind(status, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, new Date().toISOString(), PROVIDER_STRIPE, subscriptionId)
    .run();

  const billingStatus = status === "active" || status === "trialing" ? "active"
    : status === "past_due" ? "past_due"
      : status === "canceled" || status === "unpaid" ? "canceled"
        : "active";
  await c.env.merlin_db
    .prepare(
      `
        UPDATE licenses
        SET billing_status = ?, billing_current_period_end = COALESCE(?, billing_current_period_end),
            billing_cancel_at_period_end = ?, updated_at = ?
        WHERE stripe_subscription_id = ?
      `,
    )
    .bind(billingStatus, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, new Date().toISOString(), subscriptionId)
    .run();
}

async function handleInvoiceFailed(c: AppContext, invoice: Record<string, unknown>) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return;
  }
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET billing_status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`)
    .bind(new Date().toISOString(), subscriptionId)
    .run();
  await c.env.merlin_db
    .prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE provider = ? AND provider_subscription_id = ?`)
    .bind(new Date().toISOString(), PROVIDER_STRIPE, subscriptionId)
    .run();

  c.executionCtx.waitUntil(sendStripeInvoicePaymentFailedNotification(c, {
    subscriptionId,
    invoice,
    origin: requestOrigin(c),
  }).catch((error) => {
    console.warn("[stripe-webhook] payment failed email failed", error instanceof Error ? error.message : error);
  }));
}

async function handleInvoicePaymentActionRequired(c: AppContext, invoice: Record<string, unknown>) {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return;
  }
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`UPDATE licenses SET billing_status = 'action_required', updated_at = ? WHERE stripe_subscription_id = ?`)
    .bind(now, subscriptionId)
    .run();
  await c.env.merlin_db
    .prepare(`UPDATE subscriptions SET status = 'action_required', updated_at = ? WHERE provider = ? AND provider_subscription_id = ?`)
    .bind(now, PROVIDER_STRIPE, subscriptionId)
    .run();

  c.executionCtx.waitUntil(sendStripeInvoicePaymentActionRequiredNotification(c, {
    subscriptionId,
    invoice,
  }).catch((error) => {
    console.warn("[stripe-webhook] payment action required email failed", error instanceof Error ? error.message : error);
  }));
}

async function getChargeForDispute(c: AppContext, dispute: Record<string, unknown>) {
  const chargeId = getStripeId(dispute.charge);
  if (!chargeId) {
    return null;
  }
  return stripeGet<StripeCharge>(c, `/charges/${encodeURIComponent(chargeId)}`);
}

function getChargeObject(value: Record<string, unknown>) {
  return getString(value.id) && value.object === "charge" ? value as unknown as StripeCharge : null;
}

async function applyChargeBillingState(
  c: AppContext,
  charge: StripeCharge,
  input: {
    paymentStatus: string;
    subscriptionStatus: string;
    billingStatus: string;
    revoke?: boolean;
    reactivateDisputeRevocation?: boolean;
    revokedReason?: string;
    revokedOrigin?: "stripe_refund" | "stripe_dispute" | "stripe_subscription";
    revokedEventId?: string | null;
  },
) {
  const customerId = getStripeId(charge.customer);
  const paymentIntentId = getStripeId(charge.payment_intent);
  const invoiceId = getStripeId(charge.invoice);
  const paymentIds = [charge.id, paymentIntentId, invoiceId].filter((value): value is string => Boolean(value));
  const now = new Date().toISOString();

  if (paymentIds.length > 0) {
    const placeholders = paymentIds.map(() => "?").join(", ");
    await c.env.merlin_db
      .prepare(
        `
          UPDATE payments
          SET status = ?
          WHERE provider = ?
            AND provider_payment_id IN (${placeholders})
        `,
      )
      .bind(input.paymentStatus, PROVIDER_STRIPE, ...paymentIds)
      .run();

    if (input.revoke) {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET status = 'revoked',
                revoked_reason = ?,
                revoked_origin = ?,
                revoked_event_id = ?,
                billing_status = ?,
                updated_at = ?
            WHERE id IN (
              SELECT license_id
              FROM payments
              WHERE provider = ?
                AND provider_payment_id IN (${placeholders})
                AND license_id IS NOT NULL
            )
          `,
        )
        .bind(input.revokedReason || "Pagamento revertido pela Stripe.", input.revokedOrigin || "stripe_refund", input.revokedEventId || null, input.billingStatus, now, PROVIDER_STRIPE, ...paymentIds)
        .run();
    } else if (input.reactivateDisputeRevocation) {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET status = CASE WHEN revoked_origin = 'stripe_dispute' THEN 'active' ELSE status END,
                revoked_reason = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_reason END,
                revoked_origin = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_origin END,
                revoked_event_id = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_event_id END,
                billing_status = ?,
                updated_at = ?
            WHERE id IN (
              SELECT license_id
              FROM payments
              WHERE provider = ?
                AND provider_payment_id IN (${placeholders})
                AND license_id IS NOT NULL
            )
          `,
        )
        .bind(input.billingStatus, now, PROVIDER_STRIPE, ...paymentIds)
        .run();
    } else {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET billing_status = ?,
                updated_at = ?
            WHERE id IN (
              SELECT license_id
              FROM payments
              WHERE provider = ?
                AND provider_payment_id IN (${placeholders})
                AND license_id IS NOT NULL
            )
          `,
        )
        .bind(input.billingStatus, now, PROVIDER_STRIPE, ...paymentIds)
        .run();
    }
  }

  if (customerId) {
    await c.env.merlin_db
      .prepare(
        `
          UPDATE payments
          SET status = ?
          WHERE provider = ?
            AND license_id IN (
              SELECT id
              FROM licenses
              WHERE source = 'stripe'
                AND stripe_customer_id = ?
            )
        `,
      )
      .bind(input.paymentStatus, PROVIDER_STRIPE, customerId)
      .run();

    await c.env.merlin_db
      .prepare(
        `
          UPDATE subscriptions
          SET status = ?,
              updated_at = ?
          WHERE provider = ?
            AND license_id IN (
              SELECT id
              FROM licenses
              WHERE source = 'stripe'
                AND stripe_customer_id = ?
            )
        `,
      )
      .bind(input.subscriptionStatus, now, PROVIDER_STRIPE, customerId)
      .run();

    if (input.revoke) {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET status = 'revoked',
                revoked_reason = ?,
                revoked_origin = ?,
                revoked_event_id = ?,
                billing_status = ?,
                updated_at = ?
            WHERE source = 'stripe'
              AND stripe_customer_id = ?
          `,
        )
        .bind(input.revokedReason || "Pagamento revertido pela Stripe.", input.revokedOrigin || "stripe_refund", input.revokedEventId || null, input.billingStatus, now, customerId)
        .run();
    } else if (input.reactivateDisputeRevocation) {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET status = CASE WHEN revoked_origin = 'stripe_dispute' THEN 'active' ELSE status END,
                revoked_reason = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_reason END,
                revoked_origin = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_origin END,
                revoked_event_id = CASE WHEN revoked_origin = 'stripe_dispute' THEN NULL ELSE revoked_event_id END,
                billing_status = ?,
                updated_at = ?
            WHERE source = 'stripe'
              AND stripe_customer_id = ?
          `,
        )
        .bind(input.billingStatus, now, customerId)
        .run();
    } else {
      await c.env.merlin_db
        .prepare(
          `
            UPDATE licenses
            SET billing_status = ?,
                updated_at = ?
            WHERE source = 'stripe'
              AND stripe_customer_id = ?
          `,
        )
        .bind(input.billingStatus, now, customerId)
        .run();
    }
  }
}

async function handleChargeDisputeOpened(c: AppContext, dispute: Record<string, unknown>) {
  const charge = await getChargeForDispute(c, dispute);
  if (!charge) {
    return;
  }
  await applyChargeBillingState(c, charge, {
    paymentStatus: "dispute_open",
    subscriptionStatus: "dispute_open",
    billingStatus: "dispute_open",
  });
}

async function handleChargeDisputeFundsWithdrawn(c: AppContext, dispute: Record<string, unknown>) {
  const charge = await getChargeForDispute(c, dispute);
  if (!charge) {
    return;
  }
  await applyChargeBillingState(c, charge, {
    paymentStatus: "dispute_open",
    subscriptionStatus: "dispute_open",
    billingStatus: "dispute_open",
  });
}

async function handleChargeDisputeClosed(c: AppContext, dispute: Record<string, unknown>) {
  const charge = await getChargeForDispute(c, dispute);
  if (!charge) {
    return;
  }
  const status = getString(dispute.status) || "unknown";
  const reason = getString(dispute.reason) || status;
  const disputeId = getString(dispute.id) || "unknown";
  if (status === "won") {
    await applyChargeBillingState(c, charge, {
      paymentStatus: "paid",
      subscriptionStatus: "active",
      billingStatus: "active",
      reactivateDisputeRevocation: true,
    });
    return;
  }

  if (status === "lost") {
    await applyChargeBillingState(c, charge, {
      paymentStatus: "disputed",
      subscriptionStatus: "disputed",
      billingStatus: "disputed",
      revoke: true,
      revokedReason: `Contestacao Stripe perdida: ${reason}`.slice(0, 255),
      revokedOrigin: "stripe_dispute",
      revokedEventId: disputeId,
    });
  }
}

async function handleChargeRefunded(c: AppContext, chargeObject: Record<string, unknown>) {
  const chargeId = getString(chargeObject.id);
  if (!chargeId) {
    return;
  }
  const charge = getChargeObject(chargeObject) || await stripeGet<StripeCharge>(c, `/charges/${encodeURIComponent(chargeId)}`);
  if (!charge?.id) {
    return;
  }
  await applyChargeBillingState(c, charge, {
    paymentStatus: "refunded",
    subscriptionStatus: "refunded",
    billingStatus: "refunded",
    revoke: true,
    revokedReason: "Pagamento reembolsado pela Stripe.",
    revokedOrigin: "stripe_refund",
    revokedEventId: charge.id,
  });
}

async function reconcileCheckoutInvoice(c: AppContext, session: Record<string, unknown>) {
  const invoiceId = getStripeId(session.invoice);
  if (!invoiceId) {
    return null;
  }

  const invoice = await stripeGet<Record<string, unknown>>(c, `/invoices/${encodeURIComponent(invoiceId)}`);
  const invoicePaid = getString(invoice.status) === "paid" || Boolean(invoice.paid);
  if (invoicePaid) {
    await handleInvoicePaid(c, invoice);
  }
  return invoiceId;
}

async function reconcileCheckoutSubscription(c: AppContext, session: Record<string, unknown>) {
  const subscriptionId = getStripeId(session.subscription);
  if (!subscriptionId) {
    return null;
  }

  const subscription = await stripeGet<Record<string, unknown>>(c, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  await updateSubscriptionStatus(c, subscription);
  return subscriptionId;
}

export async function reconcileStripeCheckoutSession(c: AppContext, sessionId: string) {
  const safeSessionId = String(sessionId || "").trim();
  if (!safeSessionId) {
    throw new HTTPException(400, { message: "Checkout invalido." });
  }

  const session = await stripeGet<Record<string, unknown>>(c, `/checkout/sessions/${encodeURIComponent(safeSessionId)}`);
  if (getString(session.id) !== safeSessionId) {
    throw new HTTPException(502, { message: "Stripe retornou uma sessao inesperada." });
  }

  await handleCheckoutCompleted(c, session);
  const invoiceId = await reconcileCheckoutInvoice(c, session);
  const subscriptionId = await reconcileCheckoutSubscription(c, session);

  const status = await getPublicCheckoutStatus(c, safeSessionId).catch(() => null);
  return {
    sessionId: safeSessionId,
    stripeStatus: getString(session.status),
    paymentStatus: getString(session.payment_status),
    invoiceId,
    subscriptionId,
    status,
  };
}

export async function reconcileStripeLicense(c: AppContext, licenseId: number) {
  const license = await c.env.merlin_db
    .prepare(
      `
        SELECT id, stripe_checkout_session_id, stripe_subscription_id
        FROM licenses
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(licenseId)
    .first<{ id: number; stripe_checkout_session_id: string | null; stripe_subscription_id: string | null }>();

  if (!license) {
    throw new HTTPException(404, { message: "Licenca nao encontrada." });
  }

  let checkoutResult: Awaited<ReturnType<typeof reconcileStripeCheckoutSession>> | null = null;
  let subscriptionId = license.stripe_subscription_id;

  if (license.stripe_checkout_session_id) {
    checkoutResult = await reconcileStripeCheckoutSession(c, license.stripe_checkout_session_id);
    subscriptionId = checkoutResult.subscriptionId || subscriptionId;
  }

  if (subscriptionId) {
    const subscription = await stripeGet<Record<string, unknown>>(c, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    await updateSubscriptionStatus(c, subscription);
  }

  if (!license.stripe_checkout_session_id && !subscriptionId) {
    throw new HTTPException(400, { message: "Esta licenca nao possui dados Stripe para sincronizar." });
  }

  return {
    licenseId: license.id,
    checkout: checkoutResult,
    subscriptionId,
  };
}

export async function processStripeWebhookEvent(c: AppContext, event: StripeEvent) {
  const reserved = await reservePaymentEvent(c, event);
  if (!reserved) {
    return { duplicate: true, processed: false };
  }

  try {
    const object = event.data.object;
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(c, object);
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(c, object);
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(c, object);
    } else if (event.type === "invoice.payment_action_required") {
      await handleInvoicePaymentActionRequired(c, object);
    } else if (event.type === "invoice.payment_failed") {
      await handleInvoiceFailed(c, object);
    } else if (event.type === "charge.dispute.created") {
      await handleChargeDisputeOpened(c, object);
    } else if (event.type === "charge.dispute.funds_withdrawn") {
      await handleChargeDisputeFundsWithdrawn(c, object);
    } else if (event.type === "charge.dispute.closed") {
      await handleChargeDisputeClosed(c, object);
    } else if (event.type === "charge.refunded") {
      await handleChargeRefunded(c, object);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await updateSubscriptionStatus(c, object);
    }

    await markPaymentEvent(c, event.id, "processed");
    return { duplicate: false, processed: true };
  } catch (error) {
    await markPaymentEvent(c, event.id, "failed", error instanceof Error ? error.message : String(error || ""));
    throw error;
  }
}

export async function getPublicCheckoutStatus(c: AppContext, sessionId: string) {
  const checkout = await getCheckoutBySessionId(c, sessionId);
  if (!checkout) {
    throw new HTTPException(404, { message: "Checkout nao encontrado." });
  }

  if (!checkout.license_id) {
    if (checkout.status === "expired") {
      return {
        status: "expired" as const,
        checkoutStatus: checkout.status,
        paymentStatus: "expired",
      };
    }

    return {
      status: "processing" as const,
      checkoutStatus: checkout.status,
      paymentStatus: checkout.payment_status || (checkout.status === "open" ? "pending" : "processing"),
    };
  }

  const license = await getLicenseById(c, checkout.license_id);
  if (!license) {
    return {
      status: "processing" as const,
      checkoutStatus: checkout.status,
      paymentStatus: "processing",
    };
  }

  return {
    status: "completed" as const,
    checkoutStatus: checkout.status,
    paymentStatus: "paid",
    license: {
      licenseKey: license.license_key,
      name: license.name,
      expiresAt: license.expires_at.slice(0, 10),
      status: license.status,
    },
  };
}

export async function getPublicCheckoutStatusByEmail(c: AppContext, email: string) {
  const emailNormalized = email.trim().toLowerCase();
  await assertRecentPublicEmailVerification(c, emailNormalized);

  const checkout = await getLatestCheckoutByEmail(c, emailNormalized);
  if (!checkout) {
    const existingLicense = await getActiveLicenseByEmail(c, emailNormalized);
    if (existingLicense) {
      return {
        status: "existing_license" as const,
        paymentStatus: "not_applicable",
        license: {
          licenseKey: existingLicense.license_key,
          name: existingLicense.name,
          expiresAt: existingLicense.expires_at.slice(0, 10),
          status: existingLicense.status,
        },
      };
    }

    return {
      status: "not_found" as const,
      paymentStatus: "not_found",
    };
  }

  if (!checkout.license_id) {
    if (checkout.status === "expired") {
      return {
        status: "expired" as const,
        checkoutStatus: checkout.status,
        paymentStatus: "expired",
        planType: checkout.plan_type,
      };
    }

    return {
      status: "processing" as const,
      checkoutStatus: checkout.status,
      paymentStatus: checkout.payment_status || (checkout.status === "open" ? "pending" : "processing"),
      planType: checkout.plan_type,
    };
  }

  const license = await getLicenseById(c, checkout.license_id);
  if (!license) {
    return {
      status: "processing" as const,
      checkoutStatus: checkout.status,
      paymentStatus: "processing",
      planType: checkout.plan_type,
    };
  }

  return {
    status: "completed" as const,
    checkoutStatus: checkout.status,
    paymentStatus: "paid",
    planType: checkout.plan_type,
    license: {
      licenseKey: license.license_key,
      name: license.name,
      expiresAt: license.expires_at.slice(0, 10),
      status: license.status,
    },
  };
}
