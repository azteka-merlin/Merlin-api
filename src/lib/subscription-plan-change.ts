import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import { PLAN_RULES, normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import { assertBillingPlanPrice, getStripePriceSnapshot } from "./billing-settings";
import type { AppContext } from "../types";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const PROVIDER_STRIPE = "stripe";

export type BillingPeriod = "monthly" | "annual";
export type BillingPlanPaymentMethod = "card" | "pix";
type ChangeTiming = "immediate" | "period_end";
type ChangeType = "upgrade" | "downgrade" | "interval_change";

type PlanPriceRow = {
  id?: number;
  payment_method?: BillingPlanPaymentMethod;
  plan_tier?: string;
  billing_period?: BillingPeriod;
  provider_price_id: string | null;
  amount_cents: number | null;
  currency: string;
  active: number;
};

type LicensePlanChangeRow = {
  id: number;
  customer_id: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id?: string | null;
  plan_tier: string | null;
  access_type: string | null;
  billing_status: string | null;
  billing_current_period_start: string | null;
  billing_current_period_end: string | null;
  billing_cancel_at_period_end: number | null;
  status: string;
};

type StripePriceLike = {
  id?: string;
  unit_amount?: number | null;
  currency?: string | null;
  recurring?: { interval?: string | null } | null;
};

type StripeSubscriptionItem = {
  id: string;
  price?: StripePriceLike | null;
  quantity?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
};

type StripeSubscriptionLike = {
  id: string;
  object?: string;
  customer?: string | Record<string, unknown> | null;
  status?: string;
  trial_end?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  latest_invoice?: string | Record<string, unknown> | null;
  pending_update?: unknown;
  items?: {
    data?: StripeSubscriptionItem[];
  } | null;
};

type StripeInvoiceLike = {
  id?: string;
  subscription?: string | Record<string, unknown> | null;
  payment_intent?: string | Record<string, unknown> | null;
  status?: string | null;
  paid?: boolean | null;
};

type StripeInvoicePreviewLike = {
  amount_due?: number | null;
  total?: number | null;
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

async function stripeGet<T>(c: AppContext, path: string) {
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    method: "GET",
    headers: { Authorization: encodeBasicAuth(stripeSecretKey(c)) },
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel consultar a Stripe.") });
  }
  return payload;
}

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: encodeBasicAuth(stripeSecretKey(c)),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiError(payload, "Nao foi possivel atualizar a Stripe.") });
  }
  return payload;
}

function getString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function getObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getStripeId(value: unknown) {
  if (typeof value === "string") return value;
  return getString(getObject(value)?.id);
}

function unixToIso(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function periodFromAccessType(accessType: string | null | undefined): BillingPeriod | null {
  if (accessType === "monthly_subscription") return "monthly";
  if (accessType === "annual_subscription") return "annual";
  return null;
}

function intervalToPeriod(interval: string | null | undefined): BillingPeriod | null {
  if (interval === "month") return "monthly";
  if (interval === "year") return "annual";
  return null;
}

function subscriptionItem(subscription: StripeSubscriptionLike): StripeSubscriptionItem | null {
  return subscription.items?.data?.[0] || null;
}

function subscriptionPeriodBounds(subscription: StripeSubscriptionLike) {
  const item = subscriptionItem(subscription);
  return {
    start: subscription.current_period_start || item?.current_period_start || null,
    end: subscription.current_period_end || item?.current_period_end || subscription.cancel_at || null,
  };
}

function prorationDateWithinCurrentPeriod(subscription: StripeSubscriptionLike, nowSeconds: number) {
  const { start, end } = subscriptionPeriodBounds(subscription);
  if (typeof start === "number" && nowSeconds < start) return start;
  if (typeof end === "number" && nowSeconds > end) return end;
  return nowSeconds;
}

function hasReachedScheduledPlanChange(subscription: StripeSubscriptionLike, effectiveAt: string | null) {
  if (!effectiveAt) return false;
  const effectiveAtSeconds = Math.floor(Date.parse(effectiveAt) / 1000);
  if (!Number.isFinite(effectiveAtSeconds)) return false;
  const { start } = subscriptionPeriodBounds(subscription);
  return typeof start === "number" && start >= effectiveAtSeconds;
}

async function getLicenseForPlanChange(c: AppContext, licenseId: number) {
  const license = await c.env.merlin_db
    .prepare(`
      SELECT id, customer_id, stripe_customer_id, stripe_subscription_id,
        plan_tier, access_type, billing_status, billing_current_period_start,
        billing_current_period_end, billing_cancel_at_period_end, status
      FROM licenses
      WHERE id = ?
      LIMIT 1
    `)
    .bind(licenseId)
    .first<LicensePlanChangeRow>();

  if (!license) throw new HTTPException(404, { message: "Licenca nao encontrada." });
  if (license.status !== "active") throw new HTTPException(409, { message: "Licenca nao esta ativa." });
  if (!license.stripe_customer_id || !license.stripe_subscription_id) {
    throw new HTTPException(409, { message: "Esta licenca nao possui assinatura Stripe para troca de plano." });
  }
  if (!periodFromAccessType(license.access_type)) {
    throw new HTTPException(409, { message: "Este tipo de acesso nao e elegivel para troca de plano." });
  }
  if (license.billing_status && ["canceled", "unpaid"].includes(license.billing_status)) {
    throw new HTTPException(409, { message: "Esta assinatura foi cancelada e nao pode mais trocar de plano." });
  }
  if (license.billing_cancel_at_period_end === 1) {
    throw new HTTPException(409, { message: "Remova o cancelamento agendado antes de trocar de plano." });
  }
  return license;
}

export async function getCardPlanPrice(c: AppContext, targetTier: PlanTier, targetPeriod: BillingPeriod) {
  return getBillingPlanPrice(c, "card", targetTier, targetPeriod, { requirePriceId: true });
}

export async function getBillingPlanPrice(
  c: AppContext,
  paymentMethod: BillingPlanPaymentMethod,
  targetTier: PlanTier,
  targetPeriod: BillingPeriod,
  options: { requirePriceId?: boolean } = {},
) {
  const row = await c.env.merlin_db
    .prepare(`
      SELECT provider_price_id, amount_cents, currency, active
      FROM billing_plan_prices
      WHERE provider = ?
        AND payment_method = ?
        AND plan_tier = ?
        AND billing_period = ?
      LIMIT 1
    `)
    .bind(PROVIDER_STRIPE, paymentMethod, targetTier, targetPeriod)
    .first<PlanPriceRow>();

  if (!row || row.active !== 1) {
    throw new HTTPException(409, { message: "Plano de destino nao esta configurado." });
  }
  if (options.requirePriceId && !row.provider_price_id) {
    throw new HTTPException(409, { message: "Price ID do plano de destino nao esta configurado." });
  }
  return row;
}

export async function listPublicBillingPlanPrices(c: AppContext) {
  const rows = await listBillingPlanPrices(c);
  return rows
    .filter((row) => row.active)
    .map((row) => ({
      paymentMethod: row.paymentMethod,
      planTier: row.planTier,
      billingPeriod: row.billingPeriod,
      amountCents: row.amountCents,
      currency: row.currency,
      active: row.active,
    }));
}

export async function listBillingPlanPrices(c: AppContext) {
  const result = await c.env.merlin_db
    .prepare(`
      SELECT id, payment_method, plan_tier, billing_period, provider_price_id, amount_cents, currency, active
      FROM billing_plan_prices
      WHERE provider = ?
      ORDER BY payment_method, billing_period, plan_tier
    `)
    .bind(PROVIDER_STRIPE)
    .all<PlanPriceRow>();

  return (result.results || []).map((row) => ({
    id: row.id,
    paymentMethod: row.payment_method,
    planTier: row.plan_tier,
    billingPeriod: row.billing_period,
    priceId: row.provider_price_id || "",
    amountCents: row.amount_cents,
    currency: row.currency || "brl",
    active: row.active === 1,
  }));
}

export function mirrorMonthlyPixPlanPrices<T extends {
  paymentMethod: BillingPlanPaymentMethod;
  planTier: PlanTier;
  billingPeriod: BillingPeriod;
  amountCents: number | null;
  currency: string;
  active: boolean;
}>(prices: T[]): T[] {
  const monthlyCards = new Map(prices
    .filter((price) => price.paymentMethod === "card" && price.billingPeriod === "monthly")
    .map((price) => [price.planTier, price]));

  return prices.map((price) => {
    if (price.paymentMethod !== "pix" || price.billingPeriod !== "monthly") return price;
    const card = monthlyCards.get(price.planTier);
    if (!card) return price;
    return {
      ...price,
      amountCents: card.amountCents,
      currency: card.currency,
      active: card.active,
    };
  });
}

export async function upsertBillingPlanPrices(c: AppContext, prices: Array<{
  paymentMethod: BillingPlanPaymentMethod;
  planTier: PlanTier;
  billingPeriod: BillingPeriod;
  priceId?: string | null;
  amountCents?: number | null;
  currency?: string;
  active?: boolean;
}>) {
  const normalizedPrices = [] as Array<{
    paymentMethod: BillingPlanPaymentMethod;
    planTier: PlanTier;
    billingPeriod: BillingPeriod;
    priceId: string | null;
    amountCents: number | null;
    currency: string;
    active: boolean;
  }>;

  for (const price of prices) {
    const active = price.active !== false;
    const priceId = price.priceId?.trim() || null;
    let amountCents = price.amountCents == null ? null : Number(price.amountCents);
    let currency = (price.currency || "brl").trim().toLowerCase();

    if (price.paymentMethod === "card" && active) {
      if (!priceId) {
        throw new HTTPException(400, { message: "Todo plano de cartao ativo precisa de um Price ID Stripe." });
      }
      const stripePrice = await getStripePriceSnapshot(c, priceId, { forceRefresh: true, allowStaleOnError: false });
      assertBillingPlanPrice(price.billingPeriod, stripePrice);
      amountCents = stripePrice?.amountCents ?? null;
      currency = stripePrice?.currency || currency;
    }

    const monthlyPixWillBeMirrored = price.paymentMethod === "pix" && price.billingPeriod === "monthly";
    if (active && !monthlyPixWillBeMirrored && (!Number.isInteger(amountCents) || Number(amountCents) <= 0)) {
      throw new HTTPException(400, { message: "Todo plano ativo precisa ter um valor maior que zero." });
    }

    normalizedPrices.push({
      paymentMethod: price.paymentMethod,
      planTier: price.planTier,
      billingPeriod: price.billingPeriod,
      priceId,
      amountCents,
      currency,
      active,
    });
  }
  const pricesToPersist = mirrorMonthlyPixPlanPrices(normalizedPrices);
  if (pricesToPersist.some((price) => price.active && (!Number.isInteger(price.amountCents) || Number(price.amountCents) <= 0))) {
    throw new HTTPException(400, { message: "Todo plano ativo precisa ter um valor maior que zero." });
  }
  const now = new Date().toISOString();
  const statements = pricesToPersist.map((price) => c.env.merlin_db
    .prepare(`
      INSERT INTO billing_plan_prices (
        provider, payment_method, plan_tier, billing_period, provider_price_id,
        amount_cents, currency, active, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, payment_method, plan_tier, billing_period)
      DO UPDATE SET
        provider_price_id = excluded.provider_price_id,
        amount_cents = excluded.amount_cents,
        currency = excluded.currency,
        active = excluded.active,
        updated_at = excluded.updated_at
    `)
    .bind(
      PROVIDER_STRIPE,
      price.paymentMethod,
      price.planTier,
      price.billingPeriod,
      price.priceId,
      price.amountCents ?? null,
      price.currency,
      price.active ? 1 : 0,
      now,
      now,
    ));

  if (statements.length > 0) {
    await c.env.merlin_db.batch(statements);
  }
  await mirrorMonthlyCardPricesToPix(c, [...new Set(normalizedPrices.map((price) => price.planTier))], now);
  return listBillingPlanPrices(c);
}

async function mirrorMonthlyCardPricesToPix(c: AppContext, tiers: PlanTier[], updatedAt: string) {
  if (tiers.length === 0) return;

  const statements = tiers.map((tier) => c.env.merlin_db.prepare(`
    INSERT INTO billing_plan_prices (
      provider, payment_method, plan_tier, billing_period, provider_price_id,
      amount_cents, currency, active, created_at, updated_at
    )
    SELECT provider, 'pix', plan_tier, billing_period, NULL,
      amount_cents, currency, active, ?, ?
    FROM billing_plan_prices
    WHERE provider = ?
      AND payment_method = 'card'
      AND plan_tier = ?
      AND billing_period = 'monthly'
    ON CONFLICT(provider, payment_method, plan_tier, billing_period)
    DO UPDATE SET
      amount_cents = excluded.amount_cents,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `).bind(updatedAt, updatedAt, PROVIDER_STRIPE, tier));

  await c.env.merlin_db.batch(statements);
}

export async function refreshBillingPlanPrices(c: AppContext) {
  const prices = await listBillingPlanPrices(c);
  const cardPrices = prices.filter((price) => price.paymentMethod === "card" && price.priceId);
  const now = new Date().toISOString();
  const statements = [];

  for (const price of cardPrices) {
    const snapshot = await getStripePriceSnapshot(c, price.priceId, { forceRefresh: true, allowStaleOnError: false });
    if (price.active) {
      assertBillingPlanPrice(price.billingPeriod as BillingPeriod, snapshot);
    }
    if (!snapshot) continue;
    statements.push(c.env.merlin_db.prepare(`
      UPDATE billing_plan_prices
      SET amount_cents = ?, currency = ?, updated_at = ?
      WHERE provider = ?
        AND payment_method = 'card'
        AND plan_tier = ?
        AND billing_period = ?
    `).bind(
      snapshot.amountCents,
      snapshot.currency,
      now,
      PROVIDER_STRIPE,
      price.planTier,
      price.billingPeriod,
    ));
  }

  if (statements.length > 0) {
    await c.env.merlin_db.batch(statements);
  }
  await mirrorMonthlyCardPricesToPix(c, planTiersFromPrices(prices), now);
  return listBillingPlanPrices(c);
}

function planTiersFromPrices(prices: Awaited<ReturnType<typeof listBillingPlanPrices>>) {
  return [...new Set(prices.map((price) => price.planTier))] as PlanTier[];
}

function classifyPlanChange(currentTier: PlanTier, currentPeriod: BillingPeriod, targetTier: PlanTier, targetPeriod: BillingPeriod): {
  changeType: ChangeType;
  timing: ChangeTiming;
} {
  const currentRank = PLAN_RULES[currentTier].rank;
  const targetRank = PLAN_RULES[targetTier].rank;
  // Preserve prepaid annual access even when the customer also chooses a higher tier.
  if (currentPeriod === "annual" && targetPeriod === "monthly") {
    if (targetRank > currentRank) return { changeType: "upgrade", timing: "period_end" };
    if (targetRank < currentRank) return { changeType: "downgrade", timing: "period_end" };
    return { changeType: "interval_change", timing: "period_end" };
  }
  if (targetRank > currentRank) return { changeType: "upgrade", timing: "immediate" };
  if (targetRank < currentRank) return { changeType: "downgrade", timing: "period_end" };
  if (currentPeriod === "monthly" && targetPeriod === "annual") return { changeType: "interval_change", timing: "immediate" };
  return { changeType: "interval_change", timing: "immediate" };
}

async function ensureNoOpenPlanChange(c: AppContext, licenseId: number) {
  const row = await c.env.merlin_db
    .prepare(`
      SELECT id, status
      FROM subscription_plan_changes
      WHERE license_id = ?
        AND status IN ('pending_payment', 'payment_action_required', 'scheduled')
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(licenseId)
    .first<{ id: number; status: string }>();

  if (row) {
    throw new HTTPException(409, { message: "Ja existe uma troca de plano em andamento para esta licenca." });
  }
}

function buildPlanChangePreview(input: {
  currentTier: PlanTier;
  currentPeriod: BillingPeriod;
  targetTier: PlanTier;
  targetPeriod: BillingPeriod;
  targetPriceId: string;
  targetAmountCents: number | null;
  targetCurrency: string;
}) {
  const { changeType, timing } = classifyPlanChange(input.currentTier, input.currentPeriod, input.targetTier, input.targetPeriod);
  return {
    currentTier: input.currentTier,
    currentPeriod: input.currentPeriod,
    targetTier: input.targetTier,
    targetPeriod: input.targetPeriod,
    targetPriceId: input.targetPriceId,
    targetAmountCents: input.targetAmountCents,
    targetCurrency: input.targetCurrency,
    changeType,
    timing,
    requiresPaymentConfirmation: timing === "immediate",
  };
}

export async function previewSubscriptionPlanChange(c: AppContext, input: { licenseId: number; targetTier: PlanTier; targetPeriod: BillingPeriod }) {
  const license = await getLicenseForPlanChange(c, input.licenseId);
  const currentPeriod = periodFromAccessType(license.access_type);
  if (!currentPeriod) throw new HTTPException(409, { message: "Periodo atual invalido." });
  const currentTier = normalizeStoredPlanTier(license.plan_tier, "ouro");
  if (currentTier === input.targetTier && currentPeriod === input.targetPeriod) {
    throw new HTTPException(409, { message: "A licenca ja esta neste plano." });
  }
  const targetPrice = await getCardPlanPrice(c, input.targetTier, input.targetPeriod);
  return buildPlanChangePreview({
    currentTier,
    currentPeriod,
    targetTier: input.targetTier,
    targetPeriod: input.targetPeriod,
    targetPriceId: targetPrice.provider_price_id || "",
    targetAmountCents: targetPrice.amount_cents,
    targetCurrency: targetPrice.currency,
  });
}

export async function previewImmediatePlanChangeCharge(c: AppContext, input: {
  licenseId: number;
  targetPriceId: string;
  targetAmountCents: number | null;
}) {
  const license = await getLicenseForPlanChange(c, input.licenseId);
  const subscriptionId = license.stripe_subscription_id;
  if (!subscriptionId) {
    throw new HTTPException(409, { message: "Esta licenca nao possui assinatura Stripe para troca de plano." });
  }
  const subscription = await stripeGet<StripeSubscriptionLike>(
    c,
    `/subscriptions/${encodeURIComponent(subscriptionId)}?expand%5B%5D=items.data.price`,
  );
  const item = subscriptionItem(subscription);
  if (!item?.id) {
    throw new HTTPException(409, { message: "Assinatura Stripe nao possui item elegivel." });
  }

  // The portal anchors immediate updates at the confirmation time. Stripe does not
  // allow an explicit proration date together with billing_cycle_anchor=now.
  const prorationDate = prorationDateWithinCurrentPeriod(subscription, Math.floor(Date.now() / 1000));
  const params = new URLSearchParams();
  params.set("subscription", subscription.id);
  params.set("subscription_details[items][0][id]", item.id);
  params.set("subscription_details[items][0][price]", input.targetPriceId);
  params.set("subscription_details[items][0][quantity]", String(item.quantity || 1));
  params.set("subscription_details[proration_behavior]", "always_invoice");
  params.set("subscription_details[billing_cycle_anchor]", "now");
  const isTrialing = subscription.status === "trialing"
    || (typeof subscription.trial_end === "number" && subscription.trial_end > prorationDate);
  if (isTrialing) {
    // The Stripe Portal ends a trial when the customer changes a subscription.
    // Mirror that behavior so the Merlin preview does not incorrectly show R$ 0.
    params.set("subscription_details[trial_end]", "now");
  }
  const invoice = await stripePost<StripeInvoicePreviewLike>(c, "/invoices/create_preview", params);
  const previewedAmountCents = typeof invoice.amount_due === "number"
    ? invoice.amount_due
    : typeof invoice.total === "number"
      ? invoice.total
      : null;
  if (previewedAmountCents === null || previewedAmountCents < 0) {
    throw new HTTPException(502, { message: "A Stripe nao retornou o valor da alteracao." });
  }
  if (isTrialing && (input.targetAmountCents === null || input.targetAmountCents < 0)) {
    throw new HTTPException(409, { message: "O valor do plano de destino nao esta configurado." });
  }
  // The Portal ends a free trial when the customer confirms an update. Stripe's
  // preview keeps the trial and returns zero, so show the full first cycle instead.
  const amountDueNowCents = isTrialing ? input.targetAmountCents! : previewedAmountCents;
  return { amountDueNowCents, prorationDate };
}

async function insertPlanChange(c: AppContext, input: {
  license: LicensePlanChangeRow;
  subscriptionItemId: string | null;
  currentTier: PlanTier;
  targetTier: PlanTier;
  currentPeriod: BillingPeriod;
  targetPeriod: BillingPeriod;
  currentPriceId: string | null;
  targetPriceId: string;
  changeType: ChangeType;
  timing: ChangeTiming;
  status: string;
  effectiveAt: string | null;
  scheduleId?: string | null;
  invoiceId?: string | null;
  paymentIntentId?: string | null;
  raw?: unknown;
}) {
  const now = new Date().toISOString();
  const result = await c.env.merlin_db
    .prepare(`
      INSERT INTO subscription_plan_changes (
        license_id, customer_id, provider, stripe_customer_id, stripe_subscription_id,
        stripe_subscription_item_id, stripe_schedule_id, stripe_invoice_id, stripe_payment_intent_id,
        current_plan_tier, target_plan_tier, current_billing_period, target_billing_period,
        current_price_id, target_price_id, change_type, timing, status,
        requested_at, effective_at, raw_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      input.license.id,
      input.license.customer_id,
      PROVIDER_STRIPE,
      input.license.stripe_customer_id,
      input.license.stripe_subscription_id,
      input.subscriptionItemId,
      input.scheduleId || null,
      input.invoiceId || null,
      input.paymentIntentId || null,
      input.currentTier,
      input.targetTier,
      input.currentPeriod,
      input.targetPeriod,
      input.currentPriceId,
      input.targetPriceId,
      input.changeType,
      input.timing,
      input.status,
      now,
      input.effectiveAt,
      input.raw ? JSON.stringify(input.raw).slice(0, 20000) : null,
      now,
      now,
    )
    .run();

  return Number(result.meta.last_row_id || 0);
}

async function updateSubscriptionPriceImmediately(c: AppContext, input: {
  subscriptionId: string;
  subscriptionItemId: string;
  targetPriceId: string;
}) {
  const params = new URLSearchParams();
  params.set("items[0][id]", input.subscriptionItemId);
  params.set("items[0][price]", input.targetPriceId);
  params.set("proration_behavior", "always_invoice");
  params.set("payment_behavior", "pending_if_incomplete");
  params.set("expand[0]", "latest_invoice.payment_intent");
  params.set("expand[1]", "items.data.price");
  return stripePost<StripeSubscriptionLike>(
    c,
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    params,
    `merlin_plan_change:${input.subscriptionId}:${input.targetPriceId}`,
  );
}

async function createPeriodEndSchedule(c: AppContext, input: {
  subscription: StripeSubscriptionLike;
  targetPriceId: string;
  retryAfterCanceledChangeId: number | null;
}) {
  const item = subscriptionItem(input.subscription);
  if (!item?.id || !item.price?.id) {
    throw new HTTPException(409, { message: "Assinatura Stripe nao possui item elegivel para agendamento." });
  }
  const { start: periodStart, end: periodEnd } = subscriptionPeriodBounds(input.subscription);
  if (!periodStart || !periodEnd) {
    throw new HTTPException(409, { message: "Assinatura Stripe nao possui periodo atual valido." });
  }

  const createParams = new URLSearchParams();
  createParams.set("from_subscription", input.subscription.id);
  let schedule: { id: string };
  try {
    schedule = await stripePost<{ id: string }>(
      c,
      "/subscription_schedules",
      createParams,
      `merlin_schedule_from:${input.subscription.id}:retry:${input.retryAfterCanceledChangeId || 0}`,
    );
  } catch (error) {
    const message = error instanceof HTTPException ? error.message : "";
    if (message.includes("already attached to a schedule")) {
      throw new HTTPException(409, {
        message: "Não foi possível agendar esta alteração porque a assinatura possui um agendamento antigo inconsistente. Tente novamente após a regularização da assinatura.",
      });
    }
    throw error;
  }

  const updateParams = new URLSearchParams();
  updateParams.set("end_behavior", "release");
  updateParams.set("phases[0][start_date]", String(periodStart));
  updateParams.set("phases[0][end_date]", String(periodEnd));
  updateParams.set("phases[0][items][0][price]", item.price.id);
  updateParams.set("phases[0][items][0][quantity]", String(item.quantity || 1));
  updateParams.set("phases[1][start_date]", String(periodEnd));
  updateParams.set("phases[1][items][0][price]", input.targetPriceId);
  updateParams.set("phases[1][items][0][quantity]", String(item.quantity || 1));
  updateParams.set("phases[1][billing_cycle_anchor]", "phase_start");
  updateParams.set("metadata[app]", "merlin");
  updateParams.set("metadata[purpose]", "plan_change");
  return stripePost<{ id: string; phases?: unknown[] }>(
    c,
    `/subscription_schedules/${encodeURIComponent(schedule.id)}`,
    updateParams,
    `merlin_schedule_update:${schedule.id}:${input.targetPriceId}`,
  );
}

async function getLatestCanceledPlanChangeId(c: AppContext, licenseId: number) {
  const row = await c.env.merlin_db
    .prepare(`
      SELECT id
      FROM subscription_plan_changes
      WHERE license_id = ? AND status IN ('canceled', 'released')
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(licenseId)
    .first<{ id: number }>();
  return row?.id || null;
}

export async function createSubscriptionPlanChange(c: AppContext, input: { licenseId: number; targetTier: PlanTier; targetPeriod: BillingPeriod }) {
  const license = await getLicenseForPlanChange(c, input.licenseId);
  await ensureNoOpenPlanChange(c, license.id);
  const currentPeriod = periodFromAccessType(license.access_type);
  if (!currentPeriod || !license.stripe_subscription_id) throw new HTTPException(409, { message: "Assinatura atual invalida." });
  const currentTier = normalizeStoredPlanTier(license.plan_tier, "ouro");
  const targetPrice = await getCardPlanPrice(c, input.targetTier, input.targetPeriod);
  const preview = buildPlanChangePreview({
    currentTier,
    currentPeriod,
    targetTier: input.targetTier,
    targetPeriod: input.targetPeriod,
    targetPriceId: targetPrice.provider_price_id || "",
    targetAmountCents: targetPrice.amount_cents,
    targetCurrency: targetPrice.currency,
  });

  const subscription = await stripeGet<StripeSubscriptionLike>(
    c,
    `/subscriptions/${encodeURIComponent(license.stripe_subscription_id)}?expand%5B%5D=items.data.price&expand%5B%5D=latest_invoice.payment_intent`,
  );
  const item = subscriptionItem(subscription);
  if (!item?.id) throw new HTTPException(409, { message: "Assinatura Stripe nao possui item elegivel." });

  if (preview.timing === "immediate") {
    const updated = await updateSubscriptionPriceImmediately(c, {
      subscriptionId: subscription.id,
      subscriptionItemId: item.id,
      targetPriceId: preview.targetPriceId,
    });
    const latestInvoice = getObject(updated.latest_invoice);
    const paymentIntent = getObject(latestInvoice?.payment_intent);
    const invoiceId = getStripeId(updated.latest_invoice);
    const paymentIntentId = getStripeId(paymentIntent);
    const invoicePaid = latestInvoice?.status === "paid" || latestInvoice?.paid === true;
    const changeId = await insertPlanChange(c, {
      license,
      subscriptionItemId: item.id,
      currentTier,
      targetTier: input.targetTier,
      currentPeriod,
      targetPeriod: input.targetPeriod,
      currentPriceId: item.price?.id || null,
      targetPriceId: preview.targetPriceId,
      changeType: preview.changeType,
      timing: preview.timing,
      status: invoicePaid ? "applied" : "pending_payment",
      effectiveAt: invoicePaid ? new Date().toISOString() : null,
      invoiceId,
      paymentIntentId,
      raw: updated,
    });
    if (invoicePaid) {
      await applyPlanChange(c, {
        subscriptionId: subscription.id,
        targetPriceId: preview.targetPriceId,
        targetTier: input.targetTier,
        targetPeriod: input.targetPeriod,
        periodStart: unixToIso(updated.current_period_start),
        periodEnd: unixToIso(updated.current_period_end),
      });
    }
    return { changeId, ...preview, status: invoicePaid ? "applied" : "pending_payment" };
  }

  const retryAfterCanceledChangeId = await getLatestCanceledPlanChangeId(c, license.id);
  const schedule = await createPeriodEndSchedule(c, {
    subscription,
    targetPriceId: preview.targetPriceId,
    retryAfterCanceledChangeId,
  });
  const changeId = await insertPlanChange(c, {
    license,
    subscriptionItemId: item.id,
    currentTier,
    targetTier: input.targetTier,
    currentPeriod,
    targetPeriod: input.targetPeriod,
    currentPriceId: item.price?.id || null,
    targetPriceId: preview.targetPriceId,
    changeType: preview.changeType,
    timing: preview.timing,
    status: "scheduled",
    effectiveAt: unixToIso(subscriptionPeriodBounds(subscription).end),
    scheduleId: schedule.id,
    raw: schedule,
  });
  return { changeId, ...preview, status: "scheduled", scheduleId: schedule.id };
}

export async function cancelScheduledSubscriptionPlanChange(c: AppContext, licenseId: number) {
  const change = await c.env.merlin_db
    .prepare(`
      SELECT id, stripe_schedule_id
      FROM subscription_plan_changes
      WHERE license_id = ? AND status = 'scheduled'
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(licenseId)
    .first<{ id: number; stripe_schedule_id: string | null }>();
  if (!change?.stripe_schedule_id) {
    throw new HTTPException(409, { message: "Nao existe downgrade agendado para esta licenca." });
  }

  await stripePost(
    c,
    `/subscription_schedules/${encodeURIComponent(change.stripe_schedule_id)}/release`,
    new URLSearchParams(),
    `merlin_schedule_release:${change.stripe_schedule_id}`,
  );
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      UPDATE subscription_plan_changes
      SET status = 'released', canceled_at = COALESCE(canceled_at, ?), updated_at = ?
      WHERE id = ? AND status = 'scheduled'
    `)
    .bind(now, now, change.id)
    .run();
  return { changeId: change.id, status: "canceled" as const };
}

async function applyPlanChange(c: AppContext, input: {
  subscriptionId: string;
  targetPriceId: string;
  targetTier: PlanTier;
  targetPeriod: BillingPeriod;
  periodStart: string | null;
  periodEnd: string | null;
}) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      UPDATE licenses
      SET plan_tier = ?,
          access_type = ?,
          billing_status = 'active',
          billing_current_period_start = COALESCE(?, billing_current_period_start),
          billing_current_period_end = COALESCE(?, billing_current_period_end),
          updated_at = ?
      WHERE stripe_subscription_id = ?
    `)
    .bind(
      input.targetTier,
      input.targetPeriod === "annual" ? "annual_subscription" : "monthly_subscription",
      input.periodStart,
      input.periodEnd,
      now,
      input.subscriptionId,
    )
    .run();

  await c.env.merlin_db
    .prepare(`
      UPDATE subscription_plan_changes
      SET status = 'applied',
          applied_at = COALESCE(applied_at, ?),
          updated_at = ?
      WHERE stripe_subscription_id = ?
        AND target_price_id = ?
        AND status IN ('pending_payment', 'payment_action_required', 'scheduled')
    `)
    .bind(now, now, input.subscriptionId, input.targetPriceId)
    .run();
}

export async function syncSubscriptionPlanFromStripe(c: AppContext, subscription: Record<string, unknown>, options: { paymentConfirmed?: boolean } = {}) {
  const typed = subscription as StripeSubscriptionLike;
  const subscriptionId = getString(typed.id);
  if (!subscriptionId) return;
  const item = subscriptionItem(typed);
  const priceId = item?.price?.id || null;
  if (!priceId) return;

  const mapping = await c.env.merlin_db
    .prepare(`
      SELECT plan_tier, billing_period
      FROM billing_plan_prices
      WHERE provider = ?
        AND payment_method = 'card'
        AND provider_price_id = ?
        AND active = 1
      LIMIT 1
    `)
    .bind(PROVIDER_STRIPE, priceId)
    .first<{ plan_tier: string; billing_period: BillingPeriod }>();

  if (!mapping) return;
  const targetTier = normalizeStoredPlanTier(mapping.plan_tier, "ouro");
  const targetPeriod = mapping.billing_period;

  const pending = await c.env.merlin_db
    .prepare(`
      SELECT id, timing, status, effective_at
      FROM subscription_plan_changes
      WHERE stripe_subscription_id = ?
        AND target_price_id = ?
        AND status IN ('pending_payment', 'payment_action_required', 'scheduled')
      ORDER BY id DESC
      LIMIT 1
    `)
    .bind(subscriptionId, priceId)
    .first<{ id: number; timing: ChangeTiming; status: string; effective_at: string | null }>();

  if (!pending) {
    // Portal-confirmed changes do not create a local pending row before Stripe's final action.
    if (!options.paymentConfirmed && (typed.status !== "active" || typed.pending_update)) return;
  } else if (pending.timing === "immediate" && !options.paymentConfirmed) {
    return;
  } else if (pending.timing === "period_end" && !hasReachedScheduledPlanChange(typed, pending.effective_at)) {
    // A schedule may surface the target price before its future phase begins.
    // Keep the current Merlin entitlement until Stripe moves the billing period.
    return;
  }

  await applyPlanChange(c, {
    subscriptionId,
    targetPriceId: priceId,
    targetTier,
    targetPeriod,
    periodStart: unixToIso(typed.current_period_start),
    periodEnd: unixToIso(typed.current_period_end || typed.cancel_at),
  });
}

export async function syncInvoicePlanChangeFromStripe(c: AppContext, invoice: Record<string, unknown>) {
  const typed = invoice as StripeInvoiceLike;
  const subscriptionId = getStripeId(typed.subscription)
    || getString(getObject(getObject(invoice.parent)?.subscription_details)?.subscription)
    || getString(getObject(invoice.subscription_details)?.subscription);
  if (!subscriptionId) return;
  const paid = typed.status === "paid" || typed.paid === true;
  if (!paid) return;
  const subscription = await stripeGet<Record<string, unknown>>(
    c,
    `/subscriptions/${encodeURIComponent(subscriptionId)}?expand%5B%5D=items.data.price`,
  );
  await syncSubscriptionPlanFromStripe(c, subscription, { paymentConfirmed: true });
}

export async function markPlanChangePaymentProblem(c: AppContext, invoice: Record<string, unknown>, status: "payment_failed" | "payment_action_required") {
  const subscriptionId = getStripeId((invoice as StripeInvoiceLike).subscription)
    || getString(getObject(getObject(invoice.parent)?.subscription_details)?.subscription)
    || getString(getObject(invoice.subscription_details)?.subscription);
  if (!subscriptionId) return;
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      UPDATE subscription_plan_changes
      SET status = ?, updated_at = ?, failure_reason = COALESCE(failure_reason, ?)
      WHERE stripe_subscription_id = ?
        AND status = 'pending_payment'
    `)
    .bind(status, now, status, subscriptionId)
    .run();
}

export async function markSubscriptionScheduleEvent(c: AppContext, schedule: Record<string, unknown>, status: "released" | "canceled" | "completed") {
  const scheduleId = getString(schedule.id);
  if (!scheduleId) return;
  const now = new Date().toISOString();
  const nextStatus = status === "canceled" ? "canceled" : status;
  await c.env.merlin_db
    .prepare(`
      UPDATE subscription_plan_changes
      SET status = CASE WHEN status = 'applied' THEN status ELSE ? END,
          canceled_at = CASE WHEN ? = 'canceled' THEN COALESCE(canceled_at, ?) ELSE canceled_at END,
          updated_at = ?
      WHERE stripe_schedule_id = ?
    `)
    .bind(nextStatus, nextStatus, now, now, scheduleId)
    .run();
}
