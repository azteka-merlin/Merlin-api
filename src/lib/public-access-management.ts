import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";
import { findLicenseByEmailContact, getLicense, normalizeContact } from "./admin-license-service";
import { createStripeBillingPortalSession, createStripeSubscriptionUpdateConfirmPortalSession } from "./billing-portal";
import { assertBillingPlanPrice, getBillingSettings, getStripePriceSnapshot, type BillingPriceSnapshot } from "./billing-settings";
import { assertRecentPublicEmailVerification } from "./email-verification";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import { compareRecoveryPin, normalizeRecoveryPin } from "./recovery-pin";
import {
  cancelScheduledSubscriptionPlanChange,
  createSubscriptionPlanChange,
  previewImmediatePlanChangeCharge,
  previewSubscriptionPlanChange,
  type BillingPeriod,
} from "./subscription-plan-change";

const PROVIDER_STRIPE = "stripe";
const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const LIFETIME_EXPIRES_AT = "9999-12-31T00:00:00.000Z";
const CHECKOUT_SESSION_TTL_SECONDS = 30 * 60;
const UPGRADE_OPERATION = "monthly_to_lifetime_upgrade";

type LicenseAccessRow = NonNullable<Awaited<ReturnType<typeof findLicenseByEmailContact>>>;

type SubscriptionAccessRow = {
  provider_subscription_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
};

type StripeSubscriptionForHostedChange = {
  id: string;
  current_period_end?: number | null;
  items?: { data?: Array<{ id?: string; price?: { id?: string | null } | null }> };
};

type StripeCheckoutSession = {
  id: string;
  object: "checkout.session";
  url: string | null;
  status: string | null;
  expires_at: number | null;
};

type OpenUpgradeCheckoutRow = {
  provider_session_id: string;
  provider_session_url: string | null;
  provider_session_expires_at: string | null;
  status: string;
  payment_status: string | null;
};

type UpgradeStatusRow = {
  id: number;
  status: string;
  payment_status: string | null;
  upgrade_processed_at: string | null;
  upgrade_cancel_error: string | null;
  license_id: number | null;
  upgrade_license_id: number | null;
};

type PublicPlanChangeRow = {
  status: string;
  target_plan_tier: string;
  target_billing_period: BillingPeriod;
  timing: "immediate" | "period_end";
  effective_at: string | null;
  failure_reason: string | null;
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
    if (error?.message) return error.message;
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

async function stripeGet<T>(c: AppContext, path: string) {
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    headers: { Authorization: encodeBasicAuth(stripeSecretKey(c)) },
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel consultar a Stripe.") });
  }
  return payload;
}

function normalizeEmail(email: string) {
  return normalizeContact(email, "email");
}

function toDateOnly(value: string | null | undefined) {
  return value ? value.slice(0, 10) : null;
}

function requestOrigin(c: AppContext) {
  const url = new URL(c.req.raw.url);
  return `${url.protocol}//${url.host}`;
}

function appendAccessState(returnPath: string, state: string) {
  return `${returnPath}${returnPath.includes("?") ? "&" : "?"}access=${encodeURIComponent(state)}`;
}

function stripeTimestampToIso(value: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function mapPrice(price: BillingPriceSnapshot | null) {
  if (!price) return null;
  return {
    amountCents: price.amountCents,
    currency: price.currency,
    recurringInterval: price.recurringInterval,
    active: price.active,
    stale: price.stale,
  };
}

function trimEnv(value: unknown) {
  return String(value || "").trim();
}

function getString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function isPixRuntimeAvailable(c: AppContext) {
  const appEnvironment = trimEnv(c.env.ENVIRONMENT).toLowerCase();
  const pixEnvironment = trimEnv(c.env.PIX_ENV).toLowerCase();
  const runtimeMatches = (appEnvironment === "staging" && pixEnvironment === "test")
    || (appEnvironment !== "staging" && pixEnvironment === "production");
  const accessToken = appEnvironment === "staging"
    ? trimEnv(c.env.MERCADO_PAGO_TEST_ACCESS_TOKEN)
    : trimEnv(c.env.MERCADO_PAGO_ACCESS_TOKEN);
  return trimEnv(c.env.PIX_ENABLED).toLowerCase() === "true"
    && trimEnv(c.env.PIX_PROVIDER) === "mercadopago"
    && runtimeMatches
    && Boolean(accessToken);
}

function isCurrentLicense(license: LicenseAccessRow) {
  if (license.status !== "active") return false;
  const expiresAt = new Date(license.expires_at);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() >= Date.now();
}

function accessKind(license: LicenseAccessRow) {
  if (license.access_type === "monthly_subscription") return "monthly" as const;
  if (license.access_type === "annual_subscription" || license.access_type === "annual_manual") return "annual" as const;
  if (license.access_type === "paid_lifetime" || license.access_type === "legacy_lifetime") return "lifetime" as const;
  return "active" as const;
}

async function getSubscription(c: AppContext, license: LicenseAccessRow) {
  if (!license.customer_id) return null;
  return c.env.merlin_db
    .prepare(
      `
        SELECT provider_subscription_id, status, current_period_end, cancel_at_period_end
        FROM subscriptions
        WHERE customer_id = ?
          AND license_id = ?
          AND provider = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
    )
    .bind(license.customer_id, license.id, PROVIDER_STRIPE)
    .first<SubscriptionAccessRow>();
}

export async function validatePublicAccessCredentials(c: AppContext, input: { email: string; recoveryPin: string }) {
  const emailNormalized = normalizeEmail(input.email);
  const license = await findLicenseByEmailContact(c, emailNormalized);
  if (!license || license.status === "revoked") {
    throw new HTTPException(401, { message: "E-mail ou PIN inválido." });
  }

  const recoveryPin = normalizeRecoveryPin(input.recoveryPin);
  if (!recoveryPin || !license.recovery_pin_hash) {
    throw new HTTPException(401, { message: "E-mail ou PIN inválido." });
  }
  const matchesRecoveryPin = await compareRecoveryPin(c, license, recoveryPin);
  if (!matchesRecoveryPin) {
    throw new HTTPException(401, { message: "E-mail ou PIN inválido." });
  }

  return { emailNormalized, license };
}

async function getVerifiedCurrentLicense(c: AppContext, input: { email: string; recoveryPin: string }) {
  const emailNormalized = normalizeEmail(input.email);
  await assertRecentPublicEmailVerification(c, emailNormalized);
  return validatePublicAccessCredentials(c, input);
}

async function getUpgradeAvailability(c: AppContext, license: LicenseAccessRow, current: boolean) {
  const billing = await getBillingSettings(c);
  if (billing.plansEnabled) {
    return { available: false, price: null };
  }
  const price = billing.prices.lifetime;
  const available = accessKind(license) === "monthly"
    && current
    && billing.billingEnabled
    && billing.lifetimeEnabled
    && Boolean(price?.active)
    && Boolean(billing.lifetimePriceId);

  let reason: string | null = null;
  if (accessKind(license) !== "monthly") reason = "not_monthly";
  else if (!current) reason = "expired";
  else if (!billing.billingEnabled) reason = "billing_disabled";
  else if (!billing.lifetimeEnabled || !billing.lifetimePriceId || !price?.active) reason = "lifetime_unavailable";

  return {
    available,
    reason,
    price: available ? mapPrice(price) : null,
  };
}

async function getRenewalAvailability(c: AppContext, license: LicenseAccessRow, current: boolean) {
  const billing = await getBillingSettings(c);
  const kind = accessKind(license);
  const price = kind === "annual" ? billing.prices.annual : billing.prices.monthly;
  const pixEnabled = kind === "annual" ? billing.pixAnnualEnabled : billing.pixMonthlyEnabled;
  const priceId = kind === "annual" ? billing.annualPriceId : billing.monthlyPriceId;
  const planEnabled = kind === "annual" ? billing.annualEnabled : billing.monthlyEnabled;
  const available = (kind === "monthly" || kind === "annual")
    && !current
    && billing.publicSignupEnabled
    && billing.billingEnabled
    && planEnabled
    && Boolean(price?.active)
    && Boolean(priceId);

  return {
    available,
    card: available,
    pix: available && isPixRuntimeAvailable(c) && billing.pixEnabled && pixEnabled,
    price: available ? mapPrice(price) : null,
  };
}

async function getPublicPlanChange(c: AppContext, licenseId: number) {
  const row = await c.env.merlin_db
    .prepare(`
      SELECT status, target_plan_tier, target_billing_period, timing, effective_at, failure_reason
      FROM subscription_plan_changes
      WHERE license_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(licenseId)
    .first<PublicPlanChangeRow>();

  if (!row) return null;
  if (!['pending_payment', 'payment_action_required', 'scheduled', 'failed'].includes(row.status)) {
    return null;
  }
  return {
    status: row.status === "failed" || row.status === "payment_action_required" ? "not_completed" : row.status,
    targetTier: row.target_plan_tier,
    targetPeriod: row.target_billing_period,
    timing: row.timing,
    effectiveAt: toDateOnly(row.effective_at),
    canCancel: row.status === "scheduled",
  };
}

function mapAccessPayload(
  license: LicenseAccessRow,
  subscription: SubscriptionAccessRow | null,
  upgrade: Awaited<ReturnType<typeof getUpgradeAvailability>>,
  renewal: Awaited<ReturnType<typeof getRenewalAvailability>>,
  planChange: Awaited<ReturnType<typeof getPublicPlanChange>>,
) {
  const kind = accessKind(license);
  const current = isCurrentLicense(license);
  const cancelAtPeriodEnd = Boolean(license.billing_cancel_at_period_end || subscription?.cancel_at_period_end);
  const currentPeriodEnd = license.billing_current_period_end || subscription?.current_period_end || null;
  return {
    status: "found" as const,
    access: {
      kind,
      name: license.name,
      current,
      accessType: license.access_type || "free",
      planTier: normalizeStoredPlanTier(license.plan_tier, "ouro"),
      billingStatus: license.billing_status || "none",
      expiresAt: toDateOnly(license.expires_at),
      subscription: kind === "monthly" || kind === "annual" ? {
        status: subscription?.status || license.billing_status || "active",
        currentPeriodEnd: toDateOnly(currentPeriodEnd),
        cancelAtPeriodEnd,
        canManage: current && Boolean(license.stripe_customer_id && license.stripe_subscription_id),
      } : null,
      upgrade,
      renewal,
      planChange,
    },
  };
}

export async function getPublicAccessDetails(c: AppContext, input: { email: string; recoveryPin: string }) {
  const { license } = await getVerifiedCurrentLicense(c, input);
  if (!license) {
    return { status: "not_found" as const };
  }
  const subscription = await getSubscription(c, license);
  const current = isCurrentLicense(license);
  const upgrade = await getUpgradeAvailability(c, license, current);
  const renewal = await getRenewalAvailability(c, license, current);
  const planChange = await getPublicPlanChange(c, license.id);
  return mapAccessPayload(license, subscription, upgrade, renewal, planChange);
}

export async function getPublicAccessDetailsForLicense(c: AppContext, licenseId: number) {
  const license = await getLicense(c, licenseId);
  if (license.status === "revoked") {
    return { status: "not_found" as const };
  }
  const subscription = await getSubscription(c, license);
  const current = isCurrentLicense(license);
  const upgrade = await getUpgradeAvailability(c, license, current);
  const renewal = await getRenewalAvailability(c, license, current);
  const planChange = await getPublicPlanChange(c, license.id);
  return mapAccessPayload(license, subscription, upgrade, renewal, planChange);
}

export async function previewPublicAccessPlanChange(
  c: AppContext,
  input: { email: string; recoveryPin: string; targetTier: PlanTier; targetPeriod: BillingPeriod },
) {
  const { license } = await getVerifiedCurrentLicense(c, input);
  if (!license || !isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  return previewPublicAccessPlanChangeForLicense(c, license.id, input);
}

export async function previewPublicAccessPlanChangeForLicense(
  c: AppContext,
  licenseId: number,
  input: { targetTier: PlanTier; targetPeriod: BillingPeriod },
) {
  const billing = await getBillingSettings(c);
  if (!billing.plansEnabled) throw new HTTPException(409, { message: "A troca de planos nao esta disponivel neste momento." });
  const preview = await previewSubscriptionPlanChange(c, { licenseId, targetTier: input.targetTier, targetPeriod: input.targetPeriod });
  if (!preview.requiresPaymentConfirmation) {
    return { ...preview, amountDueNowCents: null, prorationDate: null };
  }
  const charge = await previewImmediatePlanChangeCharge(c, {
    licenseId,
    targetPriceId: preview.targetPriceId,
    targetAmountCents: preview.targetAmountCents,
  });
  return { ...preview, ...charge };
}

export async function createPublicAccessPlanChange(
  c: AppContext,
  input: { email: string; recoveryPin: string; targetTier: PlanTier; targetPeriod: BillingPeriod },
) {
  const { license } = await getVerifiedCurrentLicense(c, input);
  if (!license || !isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  return createPublicAccessPlanChangeForLicense(c, license, input);
}

export async function createPublicAccessPlanChangeForLicense(
  c: AppContext,
  license: LicenseAccessRow,
  input: { targetTier: PlanTier; targetPeriod: BillingPeriod },
  options: { returnPath?: string } = {},
) {
  if (!isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  const billing = await getBillingSettings(c);
  if (!billing.plansEnabled) throw new HTTPException(409, { message: "A troca de planos nao esta disponivel neste momento." });
  const preview = await previewPublicAccessPlanChangeForLicense(c, license.id, {
    targetTier: input.targetTier,
    targetPeriod: input.targetPeriod,
  });
  if (preview.timing === "period_end") {
    return createSubscriptionPlanChange(c, {
      licenseId: license.id,
      targetTier: input.targetTier,
      targetPeriod: input.targetPeriod,
    });
  }

  await ensureNoPublicAccessPlanChange(c, license.id);

  if (!license.customer_id || !license.stripe_customer_id || !license.stripe_subscription_id) {
    throw new HTTPException(409, { message: "Esta assinatura nao esta elegivel para troca de plano." });
  }

  const subscription = await stripeGet<StripeSubscriptionForHostedChange>(
    c,
    `/subscriptions/${encodeURIComponent(license.stripe_subscription_id)}?expand%5B%5D=items.data.price`,
  );
  const item = subscription.items?.data?.[0];
  if (!item?.id) throw new HTTPException(409, { message: "Assinatura Stripe nao possui item elegivel." });

  const returnPath = options.returnPath || "/download";
  const portal = await createStripeSubscriptionUpdateConfirmPortalSession(c, {
    stripeCustomerId: license.stripe_customer_id,
    subscriptionId: license.stripe_subscription_id,
    subscriptionItemId: item.id,
    targetPriceId: preview.targetPriceId,
    returnPath: appendAccessState(returnPath, "plan-change-cancel"),
    completedPath: appendAccessState(returnPath, "plan-change-return"),
  });
  return { ...preview, status: "pending_payment" as const, checkoutUrl: portal.portalUrl };
}

async function ensureNoPublicAccessPlanChange(c: AppContext, licenseId: number) {
  const pending = await c.env.merlin_db
    .prepare(`
      SELECT id
      FROM subscription_plan_changes
      WHERE license_id = ?
        AND status IN ('pending_payment', 'payment_action_required', 'scheduled')
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(licenseId)
    .first<{ id: number }>();
  if (pending) {
    throw new HTTPException(409, { message: "Ja existe uma alteração de plano em andamento para esta licença." });
  }
}

export async function cancelPublicAccessPlanChange(c: AppContext, input: { email: string; recoveryPin: string }) {
  const { license } = await getVerifiedCurrentLicense(c, input);
  if (!license || !isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  return cancelScheduledSubscriptionPlanChange(c, license.id);
}

export async function cancelPublicAccessPlanChangeForLicense(c: AppContext, licenseId: number) {
  const license = await getLicense(c, licenseId);
  if (!isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  return cancelScheduledSubscriptionPlanChange(c, license.id);
}

async function findReusableUpgradeCheckout(c: AppContext, licenseId: number) {
  const now = new Date().toISOString();
  return c.env.merlin_db
    .prepare(
      `
        SELECT provider_session_id, provider_session_url, provider_session_expires_at, status, payment_status
        FROM checkout_sessions
        WHERE provider = ?
          AND operation_type = ?
          AND upgrade_license_id = ?
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
    .bind(PROVIDER_STRIPE, UPGRADE_OPERATION, licenseId, now)
    .first<OpenUpgradeCheckoutRow>();
}

function buildUpgradeIdempotencyKey(input: { customerId: number; licenseId: number }) {
  const bucket = Math.floor(Date.now() / (CHECKOUT_SESSION_TTL_SECONDS * 1000));
  return ["merlin_upgrade", input.customerId, input.licenseId, bucket].join(":");
}

async function createStripeUpgradeCheckoutSession(
  c: AppContext,
  input: {
    customerId: number;
    licenseId: number;
    subscriptionId: string;
    stripeCustomerId: string;
    email: string;
    priceId: string;
    idempotencyKey: string;
  },
) {
  const origin = requestOrigin(c);
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer", input.stripeCustomerId);
  params.set("client_reference_id", String(input.customerId));
  params.set("line_items[0][price]", input.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("payment_method_types[0]", "card");
  params.set("payment_method_options[card][request_three_d_secure]", "automatic");
  params.set("success_url", `${origin}/download?access=upgrade-success&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${origin}/download?access=upgrade-cancel`);
  params.set("expires_at", String(Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_TTL_SECONDS));
  params.set("metadata[operation_type]", UPGRADE_OPERATION);
  params.set("metadata[merlin_customer_id]", String(input.customerId));
  params.set("metadata[upgrade_license_id]", String(input.licenseId));
  params.set("metadata[upgrade_subscription_id]", input.subscriptionId);
  params.set("metadata[plan_type]", "lifetime");
  params.set("metadata[email]", input.email);
  params.set("payment_intent_data[metadata][operation_type]", UPGRADE_OPERATION);
  params.set("payment_intent_data[metadata][merlin_customer_id]", String(input.customerId));
  params.set("payment_intent_data[metadata][upgrade_license_id]", String(input.licenseId));
  params.set("payment_intent_data[metadata][upgrade_subscription_id]", input.subscriptionId);
  params.set("payment_intent_data[metadata][plan_type]", "lifetime");
  params.set("payment_intent_data[metadata][email]", input.email);

  const session = await stripePost<StripeCheckoutSession>(c, "/checkout/sessions", params, {
    idempotencyKey: input.idempotencyKey,
  });
  if (session.object !== "checkout.session" || !session.id || !session.url) {
    throw new HTTPException(502, { message: "Sessao de checkout invalida retornada pela Stripe." });
  }
  return session;
}

export async function createPublicAccessUpgradeCheckout(c: AppContext, input: { email: string; recoveryPin: string }) {
  const { emailNormalized, license } = await getVerifiedCurrentLicense(c, input);
  if (!license) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  if (accessKind(license) !== "monthly" || !license.customer_id || !license.stripe_customer_id || !license.stripe_subscription_id) {
    throw new HTTPException(409, { message: "Este acesso nao possui uma mensalidade elegivel para upgrade." });
  }

  const billing = await getBillingSettings(c);
  if (billing.plansEnabled) {
    throw new HTTPException(409, { message: "A troca para vitalicio nao esta disponivel com a estrutura de planos ativa." });
  }
  if (!billing.billingEnabled || !billing.lifetimeEnabled || !billing.lifetimePriceId) {
    throw new HTTPException(409, { message: "Upgrade para vitalicio esta temporariamente indisponivel." });
  }
  const price = await getStripePriceSnapshot(c, billing.lifetimePriceId, { forceRefresh: true, allowStaleOnError: false });
  assertBillingPlanPrice("lifetime", price);

  const existing = await findReusableUpgradeCheckout(c, license.id);
  if (existing?.provider_session_url && existing.status === "open") {
    return { checkoutUrl: existing.provider_session_url, checkoutSessionId: existing.provider_session_id, reused: true };
  }
  if (existing) {
    throw new HTTPException(409, { message: "Ja existe um upgrade em processamento para este acesso. Consulte novamente em alguns instantes." });
  }

  const idempotencyKey = buildUpgradeIdempotencyKey({ customerId: license.customer_id, licenseId: license.id });
  const session = await createStripeUpgradeCheckoutSession(c, {
    customerId: license.customer_id,
    licenseId: license.id,
    subscriptionId: license.stripe_subscription_id,
    stripeCustomerId: license.stripe_customer_id,
    email: emailNormalized,
    priceId: billing.lifetimePriceId,
    idempotencyKey,
  });
  const now = new Date().toISOString();

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
          payment_status,
          provider_session_url,
          provider_session_expires_at,
          idempotency_key,
          operation_type,
          upgrade_license_id,
          upgrade_subscription_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'lifetime', 'payment', ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      license.customer_id,
      PROVIDER_STRIPE,
      session.id,
      billing.lifetimePriceId,
      session.status || "open",
      session.url,
      stripeTimestampToIso(session.expires_at),
      idempotencyKey,
      UPGRADE_OPERATION,
      license.id,
      license.stripe_subscription_id,
      now,
      now,
    )
    .run();

  return { checkoutUrl: session.url, checkoutSessionId: session.id, reused: false };
}

export async function createPublicAccessBillingPortal(c: AppContext, input: { email: string; recoveryPin: string }) {
  const { license } = await getVerifiedCurrentLicense(c, input);
  if (!license || !isCurrentLicense(license)) {
    throw new HTTPException(404, { message: "Nao encontramos um acesso ativo para este e-mail." });
  }
  return createPublicAccessBillingPortalForLicense(c, license, "/download?access=portal-return");
}

export async function createPublicAccessBillingPortalForLicense(c: AppContext, license: LicenseAccessRow, returnPath: string) {
  if (!["monthly", "annual"].includes(accessKind(license)) || !license.stripe_customer_id || !license.stripe_subscription_id) {
    throw new HTTPException(409, { message: "Este acesso nao possui assinatura Stripe para gerenciar." });
  }
  return createStripeBillingPortalSession(c, {
    stripeCustomerId: license.stripe_customer_id,
    returnPath,
  });
}

export async function getPublicAccessUpgradeStatus(c: AppContext, sessionId: string) {
  const checkout = await c.env.merlin_db
    .prepare(
      `
        SELECT id, status, payment_status, upgrade_processed_at, upgrade_cancel_error, license_id, upgrade_license_id
        FROM checkout_sessions
        WHERE provider = ?
          AND provider_session_id = ?
          AND operation_type = ?
        LIMIT 1
      `,
    )
    .bind(PROVIDER_STRIPE, sessionId, UPGRADE_OPERATION)
    .first<UpgradeStatusRow>();

  if (!checkout) {
    throw new HTTPException(404, { message: "Upgrade nao encontrado." });
  }
  if (checkout.upgrade_processed_at && (checkout.license_id || checkout.upgrade_license_id)) {
    return {
      status: "completed" as const,
      paymentStatus: "paid",
      cancelWarning: Boolean(checkout.upgrade_cancel_error),
    };
  }
  if (checkout.status === "expired") {
    return { status: "expired" as const, paymentStatus: "expired" };
  }
  return {
    status: "processing" as const,
    paymentStatus: checkout.payment_status || (checkout.status === "open" ? "pending" : "processing"),
  };
}

export { UPGRADE_OPERATION, LIFETIME_EXPIRES_AT };
