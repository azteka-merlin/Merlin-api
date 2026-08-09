import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";
import { assertBillingPlanPrice, getBillingSettings, getStripePriceSnapshot, type BillingPlanType } from "./billing-settings";
import { findLicenseByEmailContact, normalizeContact } from "./admin-license-service";
import { assertRecentPublicEmailVerification, consumePublicEmailVerification } from "./email-verification";
import { generateLicenseKey } from "./licenses";
import { RECOVERY_SECRET_DESCRIPTION, hashRecoveryPin, normalizeRecoveryPin } from "./recovery-pin";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const PROVIDER_STRIPE = "stripe";
const CHECKOUT_SESSION_TTL_SECONDS = 30 * 60;
const MAX_USER_AGENT_LENGTH = 500;

type CustomerRow = {
  id: number;
  email: string;
  email_normalized: string;
  email_verified_at: string | null;
  stripe_customer_id: string | null;
};

type StripeCustomer = {
  id: string;
  object: "customer";
};

type StripeCheckoutSession = {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: string | null;
  expires_at: number | null;
};

type OpenCheckoutRow = {
  provider_session_id: string;
  provider_session_url: string | null;
  provider_session_expires_at: string | null;
  plan_type: BillingPlanType;
  status: string;
  payment_status: string | null;
  reactivation_license_id: number | null;
};

type CheckoutSessionByIdempotencyRow = {
  provider_session_id: string;
  provider_session_url: string | null;
};

export type PublicCheckoutInput = {
  name: string;
  contact: string;
  recoveryPin: string;
  acceptedRecoveryNotice: boolean;
  planType: BillingPlanType;
};

function encodeBasicAuth(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

function stripeSecretKey(c: AppContext) {
  if (!c.env.STRIPE_SECRET_KEY) {
    throw new HTTPException(503, { message: "Stripe nao esta configurado neste ambiente." });
  }
  return c.env.STRIPE_SECRET_KEY;
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

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams, options: { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: encodeBasicAuth(stripeSecretKey(c)),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel criar a sessao na Stripe.") });
  }
  return payload;
}

function checkoutMode(planType: BillingPlanType) {
  return planType === "monthly" ? "subscription" : "payment";
}

function normalizeEmail(email: string) {
  return normalizeContact(email, "email");
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
  priceId: string;
  amountCents: number;
  currency: string;
  acceptedRecoveryNoticeAt: string;
  billingEnabledAtCheckout: boolean;
}) {
  return JSON.stringify({
    emailVerifiedAt: input.emailVerifiedAt,
    planType: input.planType,
    priceId: input.priceId,
    amountCents: input.amountCents,
    currency: input.currency,
    acceptedRecoveryNoticeAt: input.acceptedRecoveryNoticeAt,
    billingEnabledAtCheckout: input.billingEnabledAtCheckout,
  });
}

async function getCustomerByEmail(c: AppContext, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, email, email_normalized, email_verified_at, stripe_customer_id
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
          SELECT id, email, email_normalized, email_verified_at, stripe_customer_id
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

async function createStripeCustomer(c: AppContext, input: { customerId: number; email: string; name: string }) {
  const params = new URLSearchParams();
  params.set("email", input.email);
  params.set("name", input.name);
  params.set("metadata[merlin_customer_id]", String(input.customerId));

  const customer = await stripePost<StripeCustomer>(c, "/customers", params);
  if (customer.object !== "customer" || !customer.id) {
    throw new HTTPException(502, { message: "Customer invalido retornado pela Stripe." });
  }

  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`UPDATE customers SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
    .bind(customer.id, now, input.customerId)
    .run();

  return customer.id;
}

async function getOrCreateStripeCustomer(c: AppContext, customer: CustomerRow, input: { email: string; name: string }) {
  if (customer.stripe_customer_id) {
    return customer.stripe_customer_id;
  }
  return createStripeCustomer(c, { customerId: customer.id, email: input.email, name: input.name });
}

async function findPendingCheckout(c: AppContext, customerId: number) {
  const now = new Date().toISOString();
  return c.env.merlin_db
    .prepare(
      `
        SELECT provider_session_id, provider_session_url, provider_session_expires_at, plan_type, status, payment_status, reactivation_license_id
        FROM checkout_sessions
        WHERE customer_id = ?
          AND provider = ?
          AND license_id IS NULL
          AND (
            (
              status = 'open'
              AND provider_session_url IS NOT NULL
              AND provider_session_expires_at IS NOT NULL
              AND provider_session_expires_at > ?
            )
            OR payment_status = 'paid'
            OR status IN ('complete', 'completed', 'processing')
          )
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .bind(customerId, PROVIDER_STRIPE, now)
    .first<OpenCheckoutRow>();
}

async function expireStaleOpenCheckouts(c: AppContext, customerId: number) {
  await c.env.merlin_db
    .prepare(
      `
        UPDATE checkout_sessions
        SET status = 'expired',
            payment_status = COALESCE(payment_status, 'expired')
        WHERE customer_id = ?
          AND provider = ?
          AND license_id IS NULL
          AND status = 'open'
          AND provider_session_expires_at IS NOT NULL
          AND provider_session_expires_at <= ?
      `,
    )
    .bind(customerId, PROVIDER_STRIPE, new Date().toISOString())
    .run();
}

async function findCheckoutByIdempotencyKey(c: AppContext, idempotencyKey: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT provider_session_id, provider_session_url
        FROM checkout_sessions
        WHERE provider = ?
          AND idempotency_key = ?
        LIMIT 1
      `,
    )
    .bind(PROVIDER_STRIPE, idempotencyKey)
    .first<CheckoutSessionByIdempotencyRow>();
}

function isSameCheckoutContext(checkout: OpenCheckoutRow, planType: BillingPlanType, reactivationLicenseId: number | null) {
  return checkout.plan_type === planType && (checkout.reactivation_license_id ?? null) === reactivationLicenseId;
}

function isReusableCheckout(checkout: OpenCheckoutRow, planType: BillingPlanType, reactivationLicenseId: number | null) {
  return checkout.status === "open"
    && Boolean(checkout.provider_session_url)
    && isSameCheckoutContext(checkout, planType, reactivationLicenseId);
}

function canPayAgain(existingLicense: Awaited<ReturnType<typeof findLicenseByEmailContact>>) {
  if (!existingLicense) {
    return false;
  }
  if (existingLicense.billing_status === "dispute_open") {
    return false;
  }
  if (existingLicense.status === "active") {
    const expiresAt = new Date(existingLicense.expires_at);
    return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now();
  }
  if (existingLicense.status !== "revoked") {
    return false;
  }
  return existingLicense.revoked_origin === "stripe_refund"
    || existingLicense.revoked_origin === "stripe_subscription";
}

function isActiveMonthlyCancelingAtPeriodEnd(existingLicense: Awaited<ReturnType<typeof findLicenseByEmailContact>>) {
  if (!existingLicense) {
    return false;
  }
  if (existingLicense.status !== "active" || existingLicense.access_type !== "monthly_subscription") {
    return false;
  }
  if (!existingLicense.billing_cancel_at_period_end) {
    return false;
  }

  const expiresAt = new Date(existingLicense.expires_at);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() >= Date.now();
}

function stripeTimestampToIso(value: number | null) {
  if (!value) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function requestOrigin(c: AppContext) {
  const url = new URL(c.req.raw.url);
  return `${url.protocol}//${url.host}`;
}

async function createStripeCheckoutSession(
  c: AppContext,
  input: {
    customerId: number;
    stripeCustomerId: string;
    email: string;
    planType: BillingPlanType;
    priceId: string;
    idempotencyKey: string;
  },
) {
  const origin = requestOrigin(c);
  const params = new URLSearchParams();
  params.set("mode", checkoutMode(input.planType));
  params.set("customer", input.stripeCustomerId);
  params.set("client_reference_id", String(input.customerId));
  params.set("line_items[0][price]", input.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("payment_method_types[0]", "card");
  params.set("payment_method_options[card][request_three_d_secure]", "automatic");
  params.set("success_url", `${origin}/download?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${origin}/download?checkout=cancel`);
  params.set("expires_at", String(Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_TTL_SECONDS));
  params.set("metadata[merlin_customer_id]", String(input.customerId));
  params.set("metadata[plan_type]", input.planType);
  params.set("metadata[email]", input.email);
  if (input.planType === "monthly") {
    params.set("subscription_data[metadata][merlin_customer_id]", String(input.customerId));
    params.set("subscription_data[metadata][plan_type]", input.planType);
    params.set("subscription_data[metadata][email]", input.email);
  } else {
    params.set("payment_intent_data[metadata][merlin_customer_id]", String(input.customerId));
    params.set("payment_intent_data[metadata][plan_type]", input.planType);
    params.set("payment_intent_data[metadata][email]", input.email);
  }

  const session = await stripePost<StripeCheckoutSession>(c, "/checkout/sessions", params, {
    idempotencyKey: input.idempotencyKey,
  });
  if (session.object !== "checkout.session" || !session.id || !session.url) {
    throw new HTTPException(502, { message: "Sessao de checkout invalida retornada pela Stripe." });
  }
  return session;
}

function buildCheckoutIdempotencyKey(input: {
  customerId: number;
  planType: BillingPlanType;
  reactivationLicenseId: number | null;
}) {
  const bucket = Math.floor(Date.now() / (CHECKOUT_SESSION_TTL_SECONDS * 1000));
  return [
    "merlin_checkout",
    input.customerId,
    input.planType,
    input.reactivationLicenseId || "new",
    bucket,
  ].join(":");
}

export async function createPublicStripeCheckout(c: AppContext, input: PublicCheckoutInput) {
  const billing = await getBillingSettings(c);
  if (!billing.publicSignupEnabled) {
    throw new HTTPException(403, { message: "Cadastro publico esta desativado." });
  }
  if (!billing.billingEnabled) {
    throw new HTTPException(409, { message: "Pagamento publico esta desativado." });
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
    if (isActiveMonthlyCancelingAtPeriodEnd(existingLicense)) {
      throw new HTTPException(409, { message: "Sua mensalidade ainda esta ativa ate o fim do periodo pago. Use a opcao Gerenciar mensalidade para reativar ou alterar a assinatura." });
    }
    if (existingLicense.status === "revoked") {
      throw new HTTPException(409, { message: "Esta licenca nao pode ser reativada automaticamente. Fale com o suporte." });
    }
    throw new HTTPException(409, { message: "Este e-mail ja possui uma licenca cadastrada." });
  }

  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  if (!recoveryPin) {
    throw new HTTPException(400, { message: RECOVERY_SECRET_DESCRIPTION });
  }

  const planEnabled = input.planType === "monthly" ? billing.monthlyEnabled : billing.lifetimeEnabled;
  const priceId = input.planType === "monthly" ? billing.monthlyPriceId : billing.lifetimePriceId;
  if (!planEnabled || !priceId) {
    throw new HTTPException(400, { message: "Plano indisponivel." });
  }

  const verificationId = await assertRecentPublicEmailVerification(c, email);
  const price = await getStripePriceSnapshot(c, priceId, { forceRefresh: true, allowStaleOnError: false });
  assertBillingPlanPrice(input.planType, price);
  if (!price) {
    throw new HTTPException(400, { message: "Informe o Price ID do plano." });
  }

  const now = new Date().toISOString();
  const customer = await getOrCreateInternalCustomer(c, { email, verifiedAt: now });
  const emailVerifiedAt = customer.email_verified_at || now;
  await expireStaleOpenCheckouts(c, customer.id);
  const pendingCheckout = await findPendingCheckout(c, customer.id);
  if (pendingCheckout && isReusableCheckout(pendingCheckout, input.planType, reactivationLicenseId) && pendingCheckout.provider_session_url) {
    await consumePublicEmailVerification(c, verificationId);
    return {
      checkoutUrl: pendingCheckout.provider_session_url,
      checkoutSessionId: pendingCheckout.provider_session_id,
      reused: true,
    };
  }
  if (pendingCheckout) {
    const paidOrProcessing = pendingCheckout.payment_status === "paid"
      || pendingCheckout.status === "complete"
      || pendingCheckout.status === "completed"
      || pendingCheckout.status === "processing";
    throw new HTTPException(409, {
      message: paidOrProcessing
        ? "Ja existe um pagamento em processamento para este e-mail. Consulte o status da compra antes de tentar novamente."
        : "Ja existe um checkout aberto para este e-mail. Conclua o pagamento atual ou aguarde o link expirar antes de escolher outro plano.",
    });
  }

  const stripeCustomerId = await getOrCreateStripeCustomer(c, customer, { email, name });
  const idempotencyKey = buildCheckoutIdempotencyKey({
    customerId: customer.id,
    planType: input.planType,
    reactivationLicenseId,
  });
  const licenseKey = reactivationLicenseId ? existingLicense?.license_key || "" : generateLicenseKey();
  const recoveryPinHash = await hashRecoveryPin(c, { licenseKey, recoveryPin });
  const session = await createStripeCheckoutSession(c, {
    customerId: customer.id,
    stripeCustomerId,
    email,
    planType: input.planType,
    priceId,
    idempotencyKey,
  });
  const expiresAt = stripeTimestampToIso(session.expires_at);
  const checkoutIp = getClientIp(c);
  const checkoutCountry = getCheckoutCountry(c);
  const checkoutUserAgent = getCheckoutUserAgent(c);
  const checkoutEvidence = buildCheckoutEvidence({
    emailVerifiedAt,
    planType: input.planType,
    priceId,
    amountCents: price.amountCents,
    currency: price.currency,
    acceptedRecoveryNoticeAt: now,
    billingEnabledAtCheckout: true,
  });

  try {
    await c.env.merlin_db
      .prepare(
        `
          INSERT INTO checkout_sessions (
            customer_id,
            provider,
            provider_session_id,
            provider_price_id,
            plan_type,
            mode,
            status,
            pending_license_key,
            pending_name,
            pending_recovery_pin_hash,
            pending_recovery_notice_accepted_at,
            reactivation_license_id,
            provider_session_url,
            provider_session_expires_at,
            payment_status,
            checkout_ip,
            checkout_user_agent,
            checkout_country,
            checkout_evidence_json,
            idempotency_key,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        customer.id,
        PROVIDER_STRIPE,
        session.id,
        priceId,
        input.planType,
        checkoutMode(input.planType),
        session.status || "open",
        reactivationLicenseId ? null : licenseKey,
        name,
        recoveryPinHash,
        now,
        reactivationLicenseId,
        session.url,
        expiresAt,
        "unpaid",
        checkoutIp,
        checkoutUserAgent,
        checkoutCountry,
        checkoutEvidence,
        idempotencyKey,
        now,
      )
      .run();
  } catch (error) {
    const existingCheckout = await findCheckoutByIdempotencyKey(c, idempotencyKey);
    if (!existingCheckout?.provider_session_url) {
      throw error;
    }
    await consumePublicEmailVerification(c, verificationId);
    return {
      checkoutUrl: existingCheckout.provider_session_url,
      checkoutSessionId: existingCheckout.provider_session_id,
      reused: true,
    };
  }

  await consumePublicEmailVerification(c, verificationId);

  return {
    checkoutUrl: session.url,
    checkoutSessionId: session.id,
    reused: false,
  };
}
