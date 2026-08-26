import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { sendWelcomeAccessKeyEmail } from "./access-key-emails";
import { findLicenseByEmailContact, normalizeContact } from "./admin-license-service";
import { assertBillingPlanPrice, getBillingSettings, getStripePriceSnapshot, type BillingPlanType } from "./billing-settings";
import { assertRecentPublicEmailVerification, consumePublicEmailVerification } from "./email-verification";
import { generateLicenseKey } from "./licenses";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import { LIFETIME_EXPIRES_AT } from "./public-access-management";
import { RECOVERY_SECRET_DESCRIPTION, hashRecoveryPin, normalizeRecoveryPin } from "./recovery-pin";
import { getBillingPlanPrice } from "./subscription-plan-change";

const PROVIDER_MP = "mercadopago";
const PIX_MODE = "pix";
const CHECKOUT_SESSION_TTL_SECONDS = 30 * 60;
const MAX_USER_AGENT_LENGTH = 500;
const MP_SIGNATURE_TOLERANCE_SECONDS = 300;
type MercadoPagoRuntimeEnvironment = "test" | "production";

type CustomerRow = {
  id: number;
  email: string;
  email_normalized: string;
  email_verified_at: string | null;
};

type PixCheckoutRow = {
  id: number;
  customer_id: number;
  provider_session_id: string;
  provider_price_id: string;
  provider_payment_id: string | null;
  provider_external_reference: string | null;
  plan_tier: string | null;
  provider_qr_code: string | null;
  provider_qr_code_base64: string | null;
  provider_ticket_url: string | null;
  provider_raw_status: string | null;
  provider_status_detail: string | null;
  provider_session_expires_at: string | null;
  plan_type: BillingPlanType;
  mode: string;
  status: string;
  payment_status: string | null;
  license_id: number | null;
  reactivation_license_id: number | null;
  pending_license_key: string | null;
  pending_name: string | null;
  pending_recovery_pin_hash: string | null;
  pending_recovery_notice_accepted_at: string | null;
  checkout_evidence_json: string | null;
  processed_at: string | null;
};

type LicenseRow = {
  id: number;
  license_key: string;
  name: string;
  contact: string;
  expires_at: string;
  status: string;
};

type MercadoPagoOrder = Record<string, unknown>;
type MercadoPagoWebhookSignatureStatus = "verified" | "provider_verification_required";

type MercadoPagoWebhookEvent = {
  dataId: string;
  requestId: string;
  eventId: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
  signatureStatus: MercadoPagoWebhookSignatureStatus;
  externalReferenceHint: string;
};

export type PublicPixOrderInput = {
  name: string;
  contact: string;
  recoveryPin: string;
  acceptedRecoveryNotice: boolean;
  planType: BillingPlanType;
  planTier?: PlanTier | null;
  mercadoPagoDeviceId?: string;
};

function trimEnv(value: unknown) {
  return String(value || "").trim();
}

function getMercadoPagoRuntimeEnvironment(c: AppContext): MercadoPagoRuntimeEnvironment | null {
  const appEnvironment = trimEnv(c.env.ENVIRONMENT).toLowerCase();
  const pixEnvironment = trimEnv(c.env.PIX_ENV).toLowerCase();
  if (appEnvironment === "staging" && pixEnvironment === "test") {
    return "test";
  }
  if (appEnvironment !== "staging" && pixEnvironment === "production") {
    return "production";
  }
  return null;
}

function getMercadoPagoConfiguredAccessToken(c: AppContext, runtimeEnvironment: MercadoPagoRuntimeEnvironment) {
  return runtimeEnvironment === "test"
    ? trimEnv(c.env.MERCADO_PAGO_TEST_ACCESS_TOKEN)
    : trimEnv(c.env.MERCADO_PAGO_ACCESS_TOKEN);
}

function getMercadoPagoConfiguredWebhookSecret(c: AppContext, runtimeEnvironment: MercadoPagoRuntimeEnvironment) {
  return runtimeEnvironment === "test"
    ? trimEnv(c.env.MERCADO_PAGO_TEST_WEBHOOK_SECRET)
    : trimEnv(c.env.MERCADO_PAGO_WEBHOOK_SECRET);
}

export function isMercadoPagoPixAvailable(c: AppContext) {
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  return trimEnv(c.env.PIX_ENABLED).toLowerCase() === "true"
    && trimEnv(c.env.PIX_PROVIDER) === PROVIDER_MP
    && Boolean(runtimeEnvironment)
    && Boolean(runtimeEnvironment && getMercadoPagoConfiguredAccessToken(c, runtimeEnvironment));
}

function isMercadoPagoWebhookConfigured(c: AppContext) {
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  return trimEnv(c.env.PIX_PROVIDER) === PROVIDER_MP
    && Boolean(runtimeEnvironment)
    && Boolean(runtimeEnvironment && getMercadoPagoConfiguredAccessToken(c, runtimeEnvironment));
}

function assertPixAvailable(c: AppContext) {
  if (!isMercadoPagoPixAvailable(c)) {
    throw new HTTPException(503, { message: "Pix indisponivel neste ambiente." });
  }
}

function getMercadoPagoAccessToken(c: AppContext) {
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  const token = runtimeEnvironment ? getMercadoPagoConfiguredAccessToken(c, runtimeEnvironment) : "";
  if (!token) {
    throw new HTTPException(503, { message: "Mercado Pago nao esta configurado neste ambiente." });
  }
  return token;
}

function getMercadoPagoApiBase(c: AppContext) {
  return trimEnv(c.env.MERCADO_PAGO_API_BASE).replace(/\/$/, "") || "https://api.mercadopago.com";
}

function getMercadoPagoPayerEmail(c: AppContext, email: string) {
  if (getMercadoPagoRuntimeEnvironment(c) !== "test") {
    return email;
  }
  return trimEnv(c.env.MERCADO_PAGO_TEST_PAYER_EMAIL) || "test_user_br@testuser.com";
}

function normalizeEmail(email: string) {
  return normalizeContact(email, "email");
}

function checkoutMode(planType: BillingPlanType) {
  if (planType === "monthly") return "pix_monthly";
  if (planType === "annual") return "pix_annual";
  return "pix_lifetime";
}

function oneMonthFromNowIso() {
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

function oneYearFromNowIso() {
  const next = new Date();
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function pixProductTitle(planType: BillingPlanType, planTier: PlanTier | null) {
  const tier = planTier ? ` ${planTier.charAt(0).toUpperCase()}${planTier.slice(1)}` : "";
  if (planType === "monthly") return `Merlin${tier} mensal`;
  if (planType === "annual") return `Merlin${tier} anual`;
  return "Merlin vitalicio";
}

function pixExternalCode(planType: BillingPlanType, planTier: PlanTier | null) {
  const tier = planTier ? `_${planTier}` : "";
  if (planType === "monthly") return `merlin${tier}_monthly`;
  if (planType === "annual") return `merlin${tier}_annual`;
  return "merlin_lifetime";
}

function splitPayerName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift() || "Cliente";
  const lastName = parts.join(" ") || "Merlin";
  return { firstName, lastName };
}

function normalizeDeviceId(deviceId: unknown) {
  const value = typeof deviceId === "string" ? deviceId.trim() : "";
  return /^[A-Za-z0-9._:-]{8,200}$/.test(value) ? value : "";
}

function canPayAgain(existingLicense: Awaited<ReturnType<typeof findLicenseByEmailContact>>) {
  if (!existingLicense) {
    return false;
  }
  if (existingLicense.billing_status === "dispute_open") {
    return false;
  }
  // A free legacy access can become a paid plan without minting a second key.
  if (existingLicense.status === "active" && existingLicense.access_type === "free") {
    return true;
  }
  if (existingLicense.status === "active" || existingLicense.status === "expired") {
    const expiresAt = new Date(existingLicense.expires_at);
    return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now();
  }
  if (existingLicense.status !== "revoked") {
    return false;
  }
  return existingLicense.revoked_origin === "stripe_refund"
    || existingLicense.revoked_origin === "stripe_subscription";
}

function isSamePixCheckoutContext(checkout: PixCheckoutRow, planType: BillingPlanType, planTier: PlanTier | null, reactivationLicenseId: number | null) {
  return checkout.plan_type === planType
    && normalizeStoredPlanTier(checkout.plan_tier, "ouro") === (planTier || normalizeStoredPlanTier(checkout.plan_tier, "ouro"))
    && (checkout.reactivation_license_id ?? null) === reactivationLicenseId;
}

function getClientIp(c: AppContext) {
  return c.req.header("cf-connecting-ip")?.trim()
    || c.req.header("x-real-ip")?.trim()
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || null;
}

function getCheckoutCountry(c: AppContext) {
  return c.req.header("cf-ipcountry")?.trim().toUpperCase() || null;
}

function getCheckoutUserAgent(c: AppContext) {
  const userAgent = c.req.header("user-agent")?.trim() || null;
  return userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

function buildCheckoutEvidence(input: {
  emailVerifiedAt: string | null;
  planType: BillingPlanType;
  planTier: PlanTier | null;
  priceId: string;
  amountCents: number;
  currency: string;
  acceptedRecoveryNoticeAt: string;
  environment: MercadoPagoRuntimeEnvironment;
}) {
  return JSON.stringify({
    emailVerifiedAt: input.emailVerifiedAt,
    planType: input.planType,
    planTier: input.planTier,
    priceId: input.priceId,
    amountCents: input.amountCents,
    currency: input.currency,
    acceptedRecoveryNoticeAt: input.acceptedRecoveryNoticeAt,
    provider: PROVIDER_MP,
    paymentMethod: PIX_MODE,
    environment: input.environment,
  });
}

function syntheticPixPriceId(planTier: PlanTier, planType: BillingPlanType) {
  return `pix:${planTier}:${planType}`;
}

function isSyntheticPixPriceId(priceId: string | null | undefined) {
  return String(priceId || "").startsWith("pix:");
}

function parseCheckoutEvidence(checkout: Pick<PixCheckoutRow, "checkout_evidence_json">) {
  if (!checkout.checkout_evidence_json) {
    return null;
  }
  try {
    const parsed = JSON.parse(checkout.checkout_evidence_json) as {
      amountCents?: unknown;
      currency?: unknown;
    };
    const amountCents = Number(parsed.amountCents);
    const currency = typeof parsed.currency === "string" ? parsed.currency.toLowerCase() : "";
    if (!Number.isFinite(amountCents) || amountCents < 0 || !currency) {
      return null;
    }
    return { amountCents: Math.round(amountCents), currency };
  } catch {
    return null;
  }
}

function moneyAmount(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function getObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function getNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function arrayOfObjects(value: unknown) {
  return Array.isArray(value) ? value.map(getObject).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function getOrderId(order: MercadoPagoOrder) {
  return getString(order.id) || getString(order.order_id);
}

function getOrderStatus(order: MercadoPagoOrder) {
  return getString(order.status) || "unknown";
}

function getOrderStatusDetail(order: MercadoPagoOrder) {
  return getString(order.status_detail) || getString(order.status_detail_code);
}

function getExternalReference(order: MercadoPagoOrder) {
  return getString(order.external_reference);
}

function getOrderCurrency(order: MercadoPagoOrder) {
  return (getString(order.currency_id) || getString(order.currency) || "brl").toLowerCase();
}

function getOrderAmountCents(order: MercadoPagoOrder) {
  const totalPaid = getNumber(order.total_paid_amount);
  const total = getNumber(order.total_amount);
  const amount = totalPaid ?? total;
  return amount === null ? null : Math.round(amount * 100);
}

function isMerlinPixReference(reference: string | null | undefined) {
  return /^mpix_[0-9a-f-]{36}$/i.test(String(reference || ""));
}

function extractPixPayment(order: MercadoPagoOrder) {
  const transactions = getObject(order.transactions);
  const payments = arrayOfObjects(transactions?.payments);
  const payment = payments[0] || {};
  const paymentMethod = getObject(payment.payment_method) || {};

  return {
    paymentId: getString(payment.id) || getString(payment.payment_id) || null,
    qrCode: getString(paymentMethod.qr_code) || getString(payment.qr_code) || null,
    qrCodeBase64: getString(paymentMethod.qr_code_base64) || getString(payment.qr_code_base64) || null,
    ticketUrl: getString(paymentMethod.ticket_url) || getString(payment.ticket_url) || null,
  };
}

function mapProviderStatus(order: MercadoPagoOrder, checkout?: Pick<PixCheckoutRow, "provider_session_expires_at"> | null) {
  const status = getOrderStatus(order);
  const detail = getOrderStatusDetail(order);
  const expiredLocally = checkout?.provider_session_expires_at
    ? new Date(checkout.provider_session_expires_at).getTime() <= Date.now()
    : false;

  if (status === "processed" && detail === "accredited") {
    return "paid" as const;
  }
  if (status === "processed") {
    return "paid" as const;
  }
  if (status === "expired" || status === "cancelled" || status === "canceled" || expiredLocally) {
    return "expired" as const;
  }
  if (status === "failed" || status === "rejected") {
    return "failed" as const;
  }
  return "awaiting_payment" as const;
}

function mercadoPagoApiError(payload: unknown, fallback: string) {
  const object = getObject(payload);
  const cause = Array.isArray(object?.cause) ? object.cause.map((item) => {
    const itemObject = getObject(item);
    return getString(itemObject?.description) || getString(itemObject?.code);
  }).filter(Boolean).join("; ") : "";
  return getString(object?.message) || getString(object?.error) || cause || fallback;
}

async function mercadoPagoFetch<T>(c: AppContext, path: string, init: RequestInit = {}) {
  const response = await fetch(`${getMercadoPagoApiBase(c)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getMercadoPagoAccessToken(c)}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const rawText = await response.text().catch(() => "");
  let payload: (T & { message?: string; error?: string }) | null = null;
  try {
    payload = rawText ? JSON.parse(rawText) as T & { message?: string; error?: string } : null;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload) {
    const fallback = rawText ? rawText.slice(0, 500) : "Nao foi possivel consultar o Mercado Pago.";
    const base = mercadoPagoApiError(payload, fallback);
    const message = c.env.ENVIRONMENT === "staging" ? `Mercado Pago ${response.status}: ${base}` : "Nao foi possivel consultar o Mercado Pago.";
    throw new HTTPException(502, { message });
  }
  return payload;
}

async function createMercadoPagoOrder(
  c: AppContext,
  input: {
    externalReference: string;
    idempotencyKey: string;
    email: string;
    customerName: string;
    planType: BillingPlanType;
    planTier: PlanTier | null;
    amountCents: number;
    deviceId?: string;
  },
) {
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  const { firstName, lastName } = splitPayerName(input.customerName);
  const amount = moneyAmount(input.amountCents);
  const title = pixProductTitle(input.planType, input.planTier);
  const now = new Date().toISOString();
  return mercadoPagoFetch<MercadoPagoOrder>(c, "/v1/orders", {
    method: "POST",
    headers: {
      "X-Idempotency-Key": input.idempotencyKey,
      ...(input.deviceId ? { "X-meli-session-id": input.deviceId } : {}),
    },
    body: JSON.stringify({
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: input.externalReference,
      description: title,
      payer: {
        email: input.email,
        first_name: runtimeEnvironment === "test" ? "APRO" : firstName,
        last_name: runtimeEnvironment === "test" ? "Teste" : lastName,
      },
      items: [
        {
          external_code: pixExternalCode(input.planType, input.planTier),
          title,
          description: title,
          category_id: "digital_services",
          quantity: 1,
          unit_price: amount,
        },
      ],
      additional_info: {
        "payer.registration_date": now,
        "payer.authentication_type": "WEB",
      },
      transactions: {
        payments: [
          {
            amount,
            expiration_time: "PT30M",
            payment_method: {
              id: "pix",
              type: "bank_transfer",
            },
          },
        ],
      },
    }),
  });
}

async function getMercadoPagoOrder(c: AppContext, orderId: string) {
  return mercadoPagoFetch<MercadoPagoOrder>(c, `/v1/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
  });
}

async function getCustomerByEmail(c: AppContext, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, email, email_normalized, email_verified_at
        FROM customers
        WHERE email_normalized = ?
      `,
    )
    .bind(emailNormalized)
    .first<CustomerRow>();
}

async function createInternalCustomer(c: AppContext, input: { email: string; emailNormalized: string; verifiedAt: string }) {
  try {
    const result = await c.env.merlin_db
      .prepare(
        `
          INSERT INTO customers (email, email_normalized, email_verified_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .bind(input.email, input.emailNormalized, input.verifiedAt, input.verifiedAt, input.verifiedAt)
      .run();
    const created = await c.env.merlin_db
      .prepare(
        `
          SELECT id, email, email_normalized, email_verified_at
          FROM customers
          WHERE id = ?
        `,
      )
      .bind(Number(result.meta.last_row_id))
      .first<CustomerRow>();
    if (created) {
      return created;
    }
  } catch {
    const existing = await getCustomerByEmail(c, input.emailNormalized);
    if (existing) {
      return existing;
    }
    throw new HTTPException(500, { message: "Nao foi possivel criar o customer interno." });
  }

  throw new HTTPException(500, { message: "Nao foi possivel criar o customer interno." });
}

async function getOrCreateInternalCustomer(c: AppContext, input: { email: string; verifiedAt: string }) {
  const emailNormalized = normalizeEmail(input.email);
  const existing = await getCustomerByEmail(c, emailNormalized);
  if (existing) {
    if (!existing.email_verified_at) {
      await c.env.merlin_db
        .prepare(`UPDATE customers SET email_verified_at = ?, updated_at = ? WHERE id = ?`)
        .bind(input.verifiedAt, input.verifiedAt, existing.id)
        .run();
      return { ...existing, email_verified_at: input.verifiedAt };
    }
    return existing;
  }

  return createInternalCustomer(c, {
    email: input.email,
    emailNormalized,
    verifiedAt: input.verifiedAt,
  });
}

async function findPendingPixCheckout(c: AppContext, customerId: number) {
  const now = new Date().toISOString();
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, customer_id, provider_session_id, provider_price_id, provider_payment_id, provider_external_reference,
          provider_qr_code, provider_qr_code_base64, provider_ticket_url, provider_raw_status, provider_status_detail,
          provider_session_expires_at, plan_tier, plan_type, mode, status, payment_status, license_id, reactivation_license_id, pending_license_key,
          pending_name, pending_recovery_pin_hash, pending_recovery_notice_accepted_at, checkout_evidence_json, processed_at
        FROM checkout_sessions
        WHERE customer_id = ?
          AND provider = ?
          AND license_id IS NULL
          AND (
            (
              status = 'open'
              AND provider_session_expires_at IS NOT NULL
              AND provider_session_expires_at > ?
            )
            OR payment_status = 'paid'
            OR status IN ('completed', 'processing')
          )
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(customerId, PROVIDER_MP, now)
    .first<PixCheckoutRow>();
}

async function expireStalePixCheckouts(c: AppContext, customerId: number) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET status = 'expired',
            payment_status = COALESCE(payment_status, 'expired'),
            updated_at = ?
        WHERE customer_id = ?
          AND provider = ?
          AND license_id IS NULL
          AND status = 'open'
          AND provider_session_expires_at IS NOT NULL
          AND provider_session_expires_at <= ?
      `,
    )
    .bind(now, customerId, PROVIDER_MP, now)
    .run();
}

async function getPixCheckoutByReference(c: AppContext, reference: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, customer_id, provider_session_id, provider_price_id, provider_payment_id, provider_external_reference,
          provider_qr_code, provider_qr_code_base64, provider_ticket_url, provider_raw_status, provider_status_detail,
          provider_session_expires_at, plan_tier, plan_type, mode, status, payment_status, license_id, reactivation_license_id, pending_license_key,
          pending_name, pending_recovery_pin_hash, pending_recovery_notice_accepted_at, checkout_evidence_json, processed_at
        FROM checkout_sessions
        WHERE provider = ?
          AND provider_external_reference = ?
        LIMIT 1
      `,
    )
    .bind(PROVIDER_MP, reference)
    .first<PixCheckoutRow>();
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

async function getCustomer(c: AppContext, customerId: number) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, email, email_normalized, email_verified_at
        FROM customers
        WHERE id = ?
      `,
    )
    .bind(customerId)
    .first<CustomerRow>();
}

async function activatePixLicense(c: AppContext, checkout: PixCheckoutRow) {
  if (checkout.license_id) {
    const existing = await getLicenseById(c, checkout.license_id);
    if (existing) {
      return existing;
    }
  }
  if (!checkout.pending_name || !checkout.pending_recovery_pin_hash || (!checkout.reactivation_license_id && !checkout.pending_license_key)) {
    throw new Error(`Pix checkout ${checkout.provider_external_reference || checkout.id} is missing pending license data`);
  }

  const customer = await getCustomer(c, checkout.customer_id);
  if (!customer) {
    throw new Error(`Customer ${checkout.customer_id} not found for Pix checkout ${checkout.id}`);
  }

  const now = new Date().toISOString();
  const accessType = checkout.plan_type === "lifetime"
    ? "paid_lifetime"
    : checkout.plan_type === "annual"
      ? "annual_manual"
      : "monthly_subscription";
  const expiresAt = checkout.plan_type === "lifetime"
    ? LIFETIME_EXPIRES_AT
    : checkout.plan_type === "annual"
      ? oneYearFromNowIso()
      : oneMonthFromNowIso();
  const periodEnd = checkout.plan_type === "lifetime" ? null : expiresAt;
  const planTier = normalizeStoredPlanTier(checkout.plan_tier, "ouro");
  let licenseId: number | null = null;

  if (checkout.reactivation_license_id) {
    const existing = await getLicenseById(c, checkout.reactivation_license_id);
    if (!existing) {
      throw new Error(`Pix reactivation license ${checkout.reactivation_license_id} not found`);
    }

    await c.env.merlin_db
      .prepare(
        `
          UPDATE licenses
          SET name = ?,
              contact = ?,
              contact_type = 'email',
              recovery_pin_hash = ?,
              recovery_notice_accepted_at = ?,
              hwid = NULL,
              expires_at = ?,
              status = 'active',
              revoked_reason = NULL,
              revoked_origin = NULL,
              revoked_event_id = NULL,
              source = 'mercadopago_pix',
              plan_tier = ?,
              premium_catalog_restricted = 0,
              customer_id = ?,
              access_type = ?,
              billing_status = 'active',
              stripe_customer_id = NULL,
              stripe_subscription_id = NULL,
              stripe_checkout_session_id = NULL,
              billing_current_period_start = ?,
              billing_current_period_end = ?,
              billing_cancel_at_period_end = ?,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        checkout.pending_name,
        customer.email_normalized || customer.email,
        checkout.pending_recovery_pin_hash,
        checkout.pending_recovery_notice_accepted_at || now,
        expiresAt,
        planTier,
        customer.id,
        accessType,
        now,
        periodEnd,
        0,
        now,
        existing.id,
      )
      .run();

    licenseId = existing.id;

    await c.env.merlin_db
      .prepare(
        `
          UPDATE checkout_sessions
          SET license_id = ?,
              status = 'completed',
              completed_at = COALESCE(completed_at, ?),
              processed_at = COALESCE(processed_at, ?),
              payment_status = 'paid',
              updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(licenseId, now, now, now, checkout.id)
      .run();

    const updated = await getLicenseById(c, licenseId);
    if (!updated) {
      throw new Error(`Reactivated Pix license ${licenseId} not found`);
    }

    c.executionCtx.waitUntil(sendWelcomeAccessKeyEmail(c, {
      email: customer.email_normalized || customer.email,
      name: updated.name,
      licenseKey: updated.license_key,
    }).catch((error) => {
      console.warn("[mercadopago-pix] welcome email failed", error instanceof Error ? error.message : error);
    }));

    return updated;
  }

  try {
    const result = await c.env.merlin_db
      .prepare(
        `
          INSERT INTO licenses (
            license_key, name, contact, contact_type, source, plan_tier, recovery_pin_hash, recovery_notice_accepted_at, hwid, expires_at, status,
            revoked_reason, created_at, updated_at, customer_id, access_type, billing_status, stripe_customer_id, stripe_subscription_id,
            stripe_checkout_session_id, billing_current_period_start, billing_current_period_end, billing_cancel_at_period_end
          )
          VALUES (?, ?, ?, 'email', 'mercadopago_pix', ?, ?, ?, NULL, ?, 'active',
            NULL, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, ?)
        `,
      )
      .bind(
        checkout.pending_license_key,
        checkout.pending_name,
        customer.email_normalized || customer.email,
        planTier,
        checkout.pending_recovery_pin_hash,
        checkout.pending_recovery_notice_accepted_at || now,
        expiresAt,
        now,
        now,
        customer.id,
        accessType,
        now,
        periodEnd,
        checkout.plan_type === "monthly" ? 1 : 0,
      )
      .run();
    licenseId = Number(result.meta.last_row_id);
  } catch (error) {
    const existing = await c.env.merlin_db
      .prepare(`SELECT id, license_key, name, contact, expires_at, status FROM licenses WHERE contact_type = 'email' AND lower(contact) = ? LIMIT 1`)
      .bind(customer.email_normalized)
      .first<LicenseRow>();
    if (existing) {
      licenseId = existing.id;
    } else {
      throw error;
    }
  }

  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET license_id = ?,
            status = 'completed',
            completed_at = COALESCE(completed_at, ?),
            processed_at = COALESCE(processed_at, ?),
            payment_status = 'paid',
            updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(licenseId, now, now, now, checkout.id)
    .run();

  const license = await getLicenseById(c, licenseId);
  if (!license) {
    throw new Error(`Created Pix license ${licenseId} not found`);
  }

  c.executionCtx.waitUntil(sendWelcomeAccessKeyEmail(c, {
    email: customer.email_normalized || customer.email,
    name: license.name,
    licenseKey: license.license_key,
  }).catch((error) => {
    console.warn("[mercadopago-pix] welcome email failed", error instanceof Error ? error.message : error);
  }));

  return license;
}

async function savePixPayment(c: AppContext, checkout: PixCheckoutRow, order: MercadoPagoOrder, licenseId: number) {
  const now = new Date().toISOString();
  const payment = extractPixPayment(order);
  const evidence = parseCheckoutEvidence(checkout);
  const price = isSyntheticPixPriceId(checkout.provider_price_id)
    ? null
    : await getStripePriceSnapshot(c, checkout.provider_price_id, { forceRefresh: false, allowStaleOnError: true });
  const amountCents = evidence?.amountCents ?? price?.amountCents ?? Math.round((getNumber(order.total_amount) || 0) * 100);
  const currency = evidence?.currency || price?.currency || getString(order.currency) || "brl";
  await c.env.merlin_db
    .prepare(
      `
        INSERT OR IGNORE INTO payments (
          customer_id, license_id, provider, provider_payment_id, provider_checkout_session_id, provider_subscription_id,
          amount_cents, currency, status, payment_type, created_at
        )
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'paid', 'one_time', ?)
      `,
    )
    .bind(
      checkout.customer_id,
      licenseId,
      PROVIDER_MP,
      payment.paymentId || getOrderId(order) || checkout.provider_session_id,
      getOrderId(order) || checkout.provider_session_id,
      amountCents,
      currency,
      now,
    )
    .run();
}

function publicPixPayload(checkout: PixCheckoutRow) {
  return {
    paymentIntentId: checkout.provider_external_reference || checkout.provider_session_id,
    status: checkout.payment_status === "paid" ? "paid" : checkout.status === "expired" ? "expired" : checkout.status === "failed" ? "failed" : "awaiting_payment",
    planType: checkout.plan_type,
    planTier: checkout.plan_tier ? normalizeStoredPlanTier(checkout.plan_tier, "ouro") : null,
    qrCode: checkout.provider_qr_code,
    qrCodeBase64: checkout.provider_qr_code_base64,
    ticketUrl: checkout.provider_ticket_url,
    expiresAt: checkout.provider_session_expires_at,
  };
}

async function updateCheckoutFromOrder(c: AppContext, checkout: PixCheckoutRow, order: MercadoPagoOrder) {
  const orderId = getOrderId(order);
  const payment = extractPixPayment(order);
  const mappedStatus = mapProviderStatus(order, checkout);
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET provider_session_id = COALESCE(?, provider_session_id),
            provider_payment_id = COALESCE(?, provider_payment_id),
            provider_qr_code = COALESCE(?, provider_qr_code),
            provider_qr_code_base64 = COALESCE(?, provider_qr_code_base64),
            provider_ticket_url = COALESCE(?, provider_ticket_url),
            provider_raw_status = ?,
            provider_status_detail = ?,
            status = CASE
              WHEN ? = 'paid' THEN 'completed'
              WHEN ? = 'expired' THEN 'expired'
              WHEN ? = 'failed' THEN 'failed'
              ELSE status
            END,
            payment_status = ?,
            completed_at = CASE WHEN ? = 'paid' THEN COALESCE(completed_at, ?) ELSE completed_at END,
            updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      orderId,
      payment.paymentId,
      payment.qrCode,
      payment.qrCodeBase64,
      payment.ticketUrl,
      getOrderStatus(order),
      getOrderStatusDetail(order),
      mappedStatus,
      mappedStatus,
      mappedStatus,
      mappedStatus,
      mappedStatus,
      now,
      now,
      checkout.id,
    )
    .run();

  return getPixCheckoutByReference(c, checkout.provider_external_reference || checkout.provider_session_id);
}

async function applyPaidPixOrder(c: AppContext, checkout: PixCheckoutRow, order: MercadoPagoOrder) {
  if (checkout.processed_at && checkout.license_id) {
    const existing = await getLicenseById(c, checkout.license_id);
    if (existing) {
      return existing;
    }
  }

  const refreshed = await updateCheckoutFromOrder(c, checkout, order) || checkout;
  const license = await activatePixLicense(c, refreshed);
  await savePixPayment(c, refreshed, order, license.id);
  return license;
}

async function assertMercadoPagoOrderMatchesCheckout(
  c: AppContext,
  input: {
    event: MercadoPagoWebhookEvent;
    order: MercadoPagoOrder;
    checkout: PixCheckoutRow;
    externalReference: string;
  },
) {
  const orderId = getOrderId(input.order);
  if (orderId && orderId !== input.event.dataId) {
    throw new Error(`Mercado Pago order id mismatch: event=${input.event.dataId} provider=${orderId}`);
  }

  if (input.event.externalReferenceHint && input.event.externalReferenceHint !== input.externalReference) {
    throw new Error(`Mercado Pago external reference mismatch for order ${input.event.dataId}`);
  }

  if (input.checkout.provider_session_id && input.checkout.provider_session_id !== input.event.dataId) {
    throw new Error(`Pix checkout ${input.checkout.id} is not linked to Mercado Pago order ${input.event.dataId}`);
  }

  const expected = isSyntheticPixPriceId(input.checkout.provider_price_id)
    ? parseCheckoutEvidence(input.checkout)
    : await getStripePriceSnapshot(c, input.checkout.provider_price_id, { forceRefresh: false, allowStaleOnError: true });
  if (expected) {
    const amountCents = getOrderAmountCents(input.order);
    const currency = getOrderCurrency(input.order);
    if (amountCents !== null && amountCents !== expected.amountCents) {
      throw new Error(`Mercado Pago amount mismatch for checkout ${input.checkout.id}`);
    }
    if (currency && currency !== expected.currency.toLowerCase()) {
      throw new Error(`Mercado Pago currency mismatch for checkout ${input.checkout.id}`);
    }
  }
}

async function refreshPixCheckoutStatus(c: AppContext, checkout: PixCheckoutRow) {
  if (!checkout.provider_session_id || checkout.provider_session_id === checkout.provider_external_reference) {
    return checkout;
  }

  const order = await getMercadoPagoOrder(c, checkout.provider_session_id);
  const mappedStatus = mapProviderStatus(order, checkout);
  if (mappedStatus === "paid") {
    await applyPaidPixOrder(c, checkout, order);
  } else {
    await updateCheckoutFromOrder(c, checkout, order);
  }
  return getPixCheckoutByReference(c, checkout.provider_external_reference || checkout.provider_session_id);
}

export async function createPublicPixOrder(c: AppContext, input: PublicPixOrderInput) {
  assertPixAvailable(c);
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  if (!runtimeEnvironment) {
    throw new HTTPException(503, { message: "Pix indisponivel neste ambiente." });
  }
  const billing = await getBillingSettings(c);
  if (!billing.publicSignupEnabled) {
    throw new HTTPException(403, { message: "Cadastro publico esta desativado." });
  }
  if (!billing.billingEnabled) {
    throw new HTTPException(409, { message: "Pagamento publico esta desativado." });
  }
  if (!billing.pixEnabled) {
    throw new HTTPException(409, { message: "Pix esta desativado." });
  }
  if (billing.plansEnabled && input.planType === "lifetime") {
    throw new HTTPException(409, { message: "Novos acessos vitalicios nao estao disponiveis com a estrutura de planos ativa." });
  }

  const name = input.name.trim();
  if (!name) {
    throw new HTTPException(400, { message: "Nome e obrigatorio." });
  }
  if (!input.acceptedRecoveryNotice) {
    throw new HTTPException(400, { message: "O aviso de recuperacao precisa ser aceito." });
  }

  const email = normalizeEmail(input.contact);
  const existingLicense = await findLicenseByEmailContact(c, email);
  const reactivationLicenseId = existingLicense && canPayAgain(existingLicense) ? existingLicense.id : null;
  if (existingLicense && !reactivationLicenseId) {
    if (existingLicense.status === "revoked") {
      throw new HTTPException(409, { message: "Esta licenca nao pode ser reativada automaticamente. Fale com o suporte." });
    }
    throw new HTTPException(409, { message: "Este e-mail ja possui uma licenca cadastrada." });
  }

  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  if (!recoveryPin) {
    throw new HTTPException(400, { message: RECOVERY_SECRET_DESCRIPTION });
  }
  const mercadoPagoDeviceId = normalizeDeviceId(input.mercadoPagoDeviceId);

  const planEnabled = input.planType === "monthly"
    ? billing.monthlyEnabled
    : input.planType === "annual"
      ? billing.annualEnabled
      : billing.lifetimeEnabled;
  const pixPlanEnabled = input.planType === "monthly"
    ? billing.pixMonthlyEnabled
    : input.planType === "annual"
      ? billing.pixAnnualEnabled
      : billing.pixLifetimeEnabled;
  const selectedTier = input.planTier ? normalizeStoredPlanTier(input.planTier, "ouro") : null;
  if (billing.plansEnabled && input.planType !== "lifetime" && !selectedTier) {
    throw new HTTPException(400, { message: "Escolha um plano Bronze, Prata ou Ouro." });
  }
  const selectedTierForCheckout = billing.plansEnabled && input.planType !== "lifetime" ? selectedTier : null;
  const tierPrice = billing.plansEnabled && selectedTier && input.planType !== "lifetime"
    ? await getBillingPlanPrice(c, "pix", selectedTier, input.planType)
    : null;
  const priceId = tierPrice
    ? (tierPrice.provider_price_id || syntheticPixPriceId(selectedTier as PlanTier, input.planType))
    : input.planType === "monthly"
    ? billing.monthlyPriceId
    : input.planType === "annual"
      ? billing.pixAnnualPriceId || billing.annualPriceId
      : billing.pixLifetimePriceId || billing.lifetimePriceId;
  if (!planEnabled || !priceId) {
    throw new HTTPException(400, { message: "Plano indisponivel." });
  }
  if (!pixPlanEnabled) {
    throw new HTTPException(400, { message: "Pix indisponivel para este plano." });
  }

  const verificationId = await assertRecentPublicEmailVerification(c, email);
  const price: { amountCents: number; currency: string } | null = tierPrice
    ? {
      amountCents: tierPrice.amount_cents ?? 0,
      currency: tierPrice.currency || "brl",
    }
    : await getStripePriceSnapshot(c, priceId, { forceRefresh: true, allowStaleOnError: false });
  if (!tierPrice) {
    const priceValidationPlan = input.planType === "monthly"
      ? "monthly"
      : input.planType === "annual" && !billing.pixAnnualPriceId
        ? "annual"
        : "lifetime";
    assertBillingPlanPrice(priceValidationPlan, price as Awaited<ReturnType<typeof getStripePriceSnapshot>>);
  }
  if (!price || !price.amountCents) {
    throw new HTTPException(400, { message: "Informe o valor do plano." });
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = addSeconds(nowDate, CHECKOUT_SESSION_TTL_SECONDS);
  const customer = await getOrCreateInternalCustomer(c, { email, verifiedAt: now });
  const emailVerifiedAt = customer.email_verified_at || now;

  await expireStalePixCheckouts(c, customer.id);
  const pendingCheckout = await findPendingPixCheckout(c, customer.id);
  if (pendingCheckout) {
    if (
      pendingCheckout.status === "open"
      && pendingCheckout.provider_qr_code
      && isSamePixCheckoutContext(
        pendingCheckout,
        input.planType,
        selectedTierForCheckout,
        reactivationLicenseId,
      )
    ) {
      await consumePublicEmailVerification(c, verificationId);
      return {
        ...publicPixPayload(pendingCheckout),
        reused: true,
      };
    }
    throw new HTTPException(409, { message: "Ja existe um Pix em processamento para este e-mail. Conclua ou aguarde expirar antes de tentar novamente." });
  }

  const externalReference = `mpix_${crypto.randomUUID()}`;
  const idempotencyKey = `merlin_pix:${externalReference}`;
  const licenseKey = reactivationLicenseId ? existingLicense?.license_key || "" : generateLicenseKey();
  const recoveryPinHash = await hashRecoveryPin(c, { licenseKey, recoveryPin });
  const checkoutEvidence = buildCheckoutEvidence({
    emailVerifiedAt,
    planType: input.planType,
    planTier: selectedTierForCheckout,
    priceId,
    amountCents: price.amountCents,
    currency: price.currency,
    acceptedRecoveryNoticeAt: now,
    environment: runtimeEnvironment,
  });

  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO checkout_sessions (
          customer_id, provider, provider_session_id, provider_price_id, plan_tier, plan_type, mode, status,
          pending_license_key, pending_name, pending_recovery_pin_hash, pending_recovery_notice_accepted_at, reactivation_license_id,
          provider_session_expires_at, payment_status, checkout_ip, checkout_user_agent, checkout_country,
          checkout_evidence_json, idempotency_key, provider_external_reference, provider_environment, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      customer.id,
      PROVIDER_MP,
      externalReference,
      priceId,
      selectedTierForCheckout,
      input.planType,
      checkoutMode(input.planType),
      reactivationLicenseId ? null : licenseKey,
      name,
      recoveryPinHash,
      now,
      reactivationLicenseId,
      expiresAt,
      getClientIp(c),
      getCheckoutUserAgent(c),
      getCheckoutCountry(c),
      checkoutEvidence,
      idempotencyKey,
      externalReference,
      runtimeEnvironment,
      now,
      now,
    )
    .run();

  let checkout = await getPixCheckoutByReference(c, externalReference);
  if (!checkout) {
    throw new HTTPException(500, { message: "Nao foi possivel criar a intencao Pix." });
  }

  let order: MercadoPagoOrder;
  try {
    order = await createMercadoPagoOrder(c, {
      externalReference,
      idempotencyKey,
      email: getMercadoPagoPayerEmail(c, email),
      customerName: name,
      planType: input.planType,
      planTier: selectedTierForCheckout,
      amountCents: price.amountCents,
      deviceId: mercadoPagoDeviceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Mercado Pago request failed");
    await c.env.merlin_db
      .prepare(`UPDATE checkout_sessions SET status = 'failed', payment_status = 'failed', provider_status_detail = ?, updated_at = ? WHERE id = ?`)
      .bind(message.slice(0, 500), new Date().toISOString(), checkout.id)
      .run();
    throw error;
  }
  checkout = await updateCheckoutFromOrder(c, checkout, order) || checkout;
  await consumePublicEmailVerification(c, verificationId);

  return {
    ...publicPixPayload(checkout),
    reused: false,
  };
}

export async function getPublicPixOrderStatus(c: AppContext, paymentIntentId: string) {
  assertPixAvailable(c);
  const safeId = String(paymentIntentId || "").trim();
  if (!/^mpix_[0-9a-f-]{36}$/i.test(safeId)) {
    throw new HTTPException(400, { message: "Pix invalido." });
  }

  const checkout = await getPixCheckoutByReference(c, safeId);
  if (!checkout) {
    throw new HTTPException(404, { message: "Pix nao encontrado." });
  }

  const refreshed = await refreshPixCheckoutStatus(c, checkout).catch(() => checkout) || checkout;
  if (refreshed.license_id) {
    const license = await getLicenseById(c, refreshed.license_id);
    if (license) {
      return {
        paymentIntentId: refreshed.provider_external_reference || refreshed.provider_session_id,
        status: "paid" as const,
        paymentStatus: "paid",
        planType: refreshed.plan_type,
        planTier: refreshed.plan_tier ? normalizeStoredPlanTier(refreshed.plan_tier, "ouro") : null,
        license: {
          licenseKey: license.license_key,
          name: license.name,
          expiresAt: license.expires_at.slice(0, 10),
          status: license.status,
        },
      };
    }
  }

  return publicPixPayload(refreshed);
}

function parseMercadoPagoSignature(header: string | null | undefined) {
  const parts = String(header || "").split(",");
  let timestamp = "";
  let signature = "";
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = rawValue.join("=").trim();
    if (key === "ts") timestamp = value;
    if (key === "v1") signature = value;
  }
  return { timestamp, signature };
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

async function sha256Hex(payload: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mercadoPagoSignatureDataId(value: string) {
  return /[A-Za-z]/.test(value) ? value.toLowerCase() : value;
}

function mercadoPagoSignatureDataIdCandidates(value: string) {
  if (!value) {
    return [""];
  }
  const documentedValue = mercadoPagoSignatureDataId(value);
  return Array.from(new Set([documentedValue, value]));
}

function mercadoPagoSignatureManifest(input: { dataId: string; requestId: string; timestamp: string; preserveDataIdCase?: boolean }) {
  const parts: string[] = [];
  if (input.dataId) {
    parts.push(`id:${input.preserveDataIdCase ? input.dataId : mercadoPagoSignatureDataId(input.dataId)};`);
  }
  if (input.requestId) {
    parts.push(`request-id:${input.requestId};`);
  }
  if (input.timestamp) {
    parts.push(`ts:${input.timestamp};`);
  }
  return parts.join("");
}

function signaturePreview(value: string) {
  return value ? `${value.slice(0, 10)}...${value.slice(-10)}` : "";
}

function rawQueryParam(url: URL, key: string) {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  for (const part of query.split("&")) {
    const [rawKey, ...rawValue] = part.split("=");
    if (rawKey === key) {
      return decodeURIComponent(rawValue.join("=").replace(/\+/g, " "));
    }
  }
  return "";
}

function isLikelyMercadoPagoPixOrderSignal(input: {
  type: string | null;
  action: string | null;
  dataId: string;
  externalReference: string;
}) {
  const type = String(input.type || "").toLowerCase();
  const action = String(input.action || "").toLowerCase();
  return type === "order"
    && action.startsWith("order.")
    && /^ORD[A-Z0-9]+$/i.test(input.dataId)
    && isMerlinPixReference(input.externalReference);
}

export async function parseAndVerifyMercadoPagoWebhook(c: AppContext, rawBody: string): Promise<MercadoPagoWebhookEvent> {
  if (!isMercadoPagoWebhookConfigured(c)) {
    throw new HTTPException(503, { message: "Mercado Pago webhook nao esta configurado neste ambiente." });
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }

  const url = new URL(c.req.url);
  const queryDataId = url.searchParams.get("data.id") || rawQueryParam(url, "data.id") || "";
  const queryExternalReference = url.searchParams.get("data.external_reference") || rawQueryParam(url, "data.external_reference") || "";
  const bodyData = getObject(payload.data);
  const bodyDataId = getString(bodyData?.id) || "";
  const bodyExternalReference = getString(bodyData?.external_reference) || "";
  const bodyEventId = getString(payload.id) || "";
  const signatureDataId = queryDataId || bodyDataId;
  const resourceDataId = bodyDataId || queryDataId;
  const externalReferenceHint = queryExternalReference || bodyExternalReference;
  const payloadType = getString(payload.type) || "order";
  const payloadAction = getString(payload.action) || "order.updated";
  const requestId = c.req.header("x-request-id") || "";
  const { timestamp, signature } = parseMercadoPagoSignature(c.req.header("x-signature"));
  const timestampSeconds = Number(timestamp);

  let validSignature = false;
  const runtimeEnvironment = getMercadoPagoRuntimeEnvironment(c);
  const secret = runtimeEnvironment ? getMercadoPagoConfiguredWebhookSecret(c, runtimeEnvironment) : "";
  const signatureAttempts: Array<{ dataId: string; requestId: string; manifest: string; expected: string }> = [];
  let secretFingerprint = "";
  let ageSeconds: number | null = null;
  if (signatureDataId && resourceDataId && timestamp && Number.isFinite(timestampSeconds) && signature) {
    ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
    if (secret && ageSeconds <= MP_SIGNATURE_TOLERANCE_SECONDS) {
      const signatureIds = Array.from(new Set([
        queryDataId,
        bodyDataId,
        bodyEventId,
        queryDataId ? "" : "",
      ]));
      secretFingerprint = await sha256Hex(secret);
      const signatureRequestIds = Array.from(new Set([requestId, ""]));
      for (const signatureId of signatureIds) {
        for (const signatureCandidateDataId of mercadoPagoSignatureDataIdCandidates(signatureId)) {
          for (const signatureRequestId of signatureRequestIds) {
            const manifest = mercadoPagoSignatureManifest({
              dataId: signatureCandidateDataId,
              requestId: signatureRequestId,
              timestamp,
              preserveDataIdCase: true,
            });
            const expected = await hmacSha256Hex(secret, manifest);
            signatureAttempts.push({
              dataId: signatureCandidateDataId,
              requestId: signatureRequestId,
              manifest,
              expected: signaturePreview(expected),
            });
            if (timingSafeEqualHex(signature, expected)) {
              validSignature = true;
              break;
            }
          }
          if (validSignature) {
            break;
          }
        }
        if (validSignature) {
          break;
        }
      }
    }
  }

  if (!validSignature) {
    const allowProviderVerificationFallback = c.env.ENVIRONMENT === "staging" && runtimeEnvironment === "test";
    if (allowProviderVerificationFallback && isLikelyMercadoPagoPixOrderSignal({
      type: payloadType,
      action: payloadAction,
      dataId: resourceDataId,
      externalReference: externalReferenceHint,
    })) {
      console.info("[mercadopago-webhook:provider-verification]", {
        dataId: resourceDataId,
        externalReference: externalReferenceHint,
        payloadType,
        payloadAction,
        hasSignature: Boolean(signature),
        hasRequestId: Boolean(requestId),
      });
      return {
        dataId: resourceDataId,
        requestId,
        eventId: `provider-check:${requestId || "no-request-id"}:${payloadAction}:${resourceDataId}:${externalReferenceHint}`,
        type: payloadType,
        action: payloadAction,
        payload,
        signatureStatus: "provider_verification_required",
        externalReferenceHint,
      };
    }

    if (c.env.ENVIRONMENT === "staging") {
      console.warn("[mercadopago-webhook:signature-debug]", {
        queryDataId,
        bodyDataId,
        bodyEventId,
        queryExternalReference,
        bodyExternalReference,
        payloadType,
        payloadAction,
        resourceDataId,
        hasRequestId: Boolean(requestId),
        requestIdLength: requestId.length,
        timestamp,
        ageSeconds,
        signatureHeaderLength: String(c.req.header("x-signature") || "").length,
        signatureLength: signature.length,
        secretLength: secret.length,
        secretFingerprint: signaturePreview(secretFingerprint),
        receivedSignature: signaturePreview(signature),
        attempts: signatureAttempts,
      });
    }
    throw new HTTPException(401, { message: "Assinatura Mercado Pago invalida." });
  }

  return {
    dataId: resourceDataId,
    requestId,
    eventId: getString(payload.id) || `${requestId || "no-request-id"}:${resourceDataId}`,
    type: payloadType,
    action: payloadAction,
    payload,
    signatureStatus: "verified",
    externalReferenceHint,
  };
}

async function reservePaymentEvent(c: AppContext, event: MercadoPagoWebhookEvent) {
  const providerEventId = event.eventId || `${event.requestId}:${event.dataId}`;
  const now = new Date().toISOString();
  try {
    await c.env.merlin_db
      .prepare(
        `
          INSERT INTO payment_events (provider, provider_event_id, event_type, raw_payload, processing_status, created_at)
          VALUES (?, ?, ?, ?, 'processing', ?)
        `,
      )
      .bind(PROVIDER_MP, providerEventId, event.action || event.type, safeJsonStringify(event.payload), now)
      .run();
    return { reserved: true, providerEventId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.includes("idx_payment_events_provider_event") || message.toLowerCase().includes("unique")) {
      return { reserved: false, providerEventId };
    }
    throw error;
  }
}

async function markPaymentEvent(c: AppContext, providerEventId: string, status: "processed" | "ignored" | "failed", errorMessage?: string) {
  await c.env.merlin_db
    .prepare(
      `
        UPDATE payment_events
        SET processing_status = ?, processed_at = ?, error_message = ?
        WHERE provider = ?
          AND provider_event_id = ?
      `,
    )
    .bind(status, new Date().toISOString(), errorMessage ? errorMessage.slice(0, 500) : null, PROVIDER_MP, providerEventId)
    .run();
}

export async function processMercadoPagoWebhookEvent(c: AppContext, event: MercadoPagoWebhookEvent) {
  const reservation = await reservePaymentEvent(c, event);
  if (!reservation.reserved) {
    return { duplicate: true, processed: false };
  }

  try {
    if (event.type !== "order" || !event.action.startsWith("order.")) {
      await markPaymentEvent(c, reservation.providerEventId, "ignored");
      return { duplicate: false, processed: false, ignored: true };
    }

    if (!/^ORD[A-Z0-9]+$/i.test(event.dataId)) {
      await markPaymentEvent(c, reservation.providerEventId, "ignored");
      return { duplicate: false, processed: false, ignored: true };
    }

    const payloadData = getObject(event.payload.data);
    const payloadExternalReference = getString(payloadData?.external_reference);
    if (payloadExternalReference && !isMerlinPixReference(payloadExternalReference)) {
      await markPaymentEvent(c, reservation.providerEventId, "ignored");
      return { duplicate: false, processed: false, ignored: true };
    }

    const order = await getMercadoPagoOrder(c, event.dataId);
    const externalReference = getExternalReference(order);
    if (!externalReference || !isMerlinPixReference(externalReference)) {
      await markPaymentEvent(c, reservation.providerEventId, "ignored");
      return { duplicate: false, processed: false };
    }

    if (payloadExternalReference && payloadExternalReference !== externalReference) {
      throw new Error(`Mercado Pago payload/provider reference mismatch for order ${event.dataId}`);
    }

    const checkout = await getPixCheckoutByReference(c, externalReference);
    if (!checkout) {
      await markPaymentEvent(c, reservation.providerEventId, "ignored");
      return { duplicate: false, processed: false };
    }

    await assertMercadoPagoOrderMatchesCheckout(c, { event, order, checkout, externalReference });

    const mappedStatus = mapProviderStatus(order, checkout);
    if (mappedStatus === "paid") {
      await applyPaidPixOrder(c, checkout, order);
    } else {
      await updateCheckoutFromOrder(c, checkout, order);
    }

    await markPaymentEvent(c, reservation.providerEventId, "processed");
    return { duplicate: false, processed: mappedStatus === "paid" };
  } catch (error) {
    await markPaymentEvent(c, reservation.providerEventId, "failed", error instanceof Error ? error.message : String(error || ""));
    throw error;
  }
}
