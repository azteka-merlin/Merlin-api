import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";
import { getBillingSettings } from "./billing-settings";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import { quotePixTransition, type PixTransitionTiming, type RecurringPeriod } from "./pix-plan-transition";
import { getBillingPlanPrice } from "./subscription-plan-change";
import { getPublicAppOrigin } from "./public-origin";

export const PIX_PLAN_TRANSITION_OPERATION = "pix_plan_transition";

export async function reconcilePriorPixPlanTransitions(c: AppContext, licenseId: number) {
  const now = new Date().toISOString();
  const pending = await c.env.merlin_db.prepare(`
    SELECT id, provider, provider_session_id FROM checkout_sessions
    WHERE operation_type = ? AND upgrade_license_id = ? AND status = 'open'
      AND upgrade_processed_at IS NULL
      AND (provider = 'stripe' OR provider_session_expires_at <= ?)
  `).bind(PIX_PLAN_TRANSITION_OPERATION, licenseId, now)
    .all<{ id: number; provider: string; provider_session_id: string }>();
  for (const row of pending.results || []) {
    if (row.provider === "mercadopago") {
      const { reconcilePixCheckoutById } = await import("./mercadopago-pix");
      const reconciled = await reconcilePixCheckoutById(c, row.id);
      if (reconciled?.payment_status === "paid") throw new HTTPException(409, {
        message: "O Pix anterior foi pago. Atualize seu acesso antes de outra troca.",
      });
      continue;
    }
    if (row.provider !== "stripe" || !row.provider_session_id?.startsWith("cs_")) {
      throw new HTTPException(409, { message: "Um checkout anterior precisa ser conciliado antes de abrir outro." });
    }
    const sessionPath = `/checkout/sessions/${encodeURIComponent(row.provider_session_id)}`;
    let stripeStatus = (await stripeGet<{ status?: string }>(c, sessionPath)).status;
    if (stripeStatus === "open") {
      try {
        stripeStatus = (await stripePost<{ status?: string }>(c, `${sessionPath}/expire`,
          new URLSearchParams(), `merlin_expire:${row.provider_session_id}`)).status;
      } catch {
        // Payment may have completed between GET and expire. Re-read the
        // provider before deciding whether the old checkout can be replaced.
        stripeStatus = (await stripeGet<{ status?: string }>(c, sessionPath)).status;
      }
    }
    if (stripeStatus === "complete") {
      const { reconcileStripeCheckoutSession } = await import("./stripe-webhook");
      await reconcileStripeCheckoutSession(c, row.provider_session_id);
      throw new HTTPException(409, {
        message: "O checkout anterior foi concluido. Atualize seu acesso antes de outra troca.",
      });
    }
    if (stripeStatus !== "expired") throw new HTTPException(409, {
      message: "Nao foi possivel encerrar o checkout anterior na Stripe. Tente novamente em instantes.",
    });
    await c.env.merlin_db.prepare(`
      UPDATE checkout_sessions SET status = 'expired', updated_at = ?
      WHERE id = ? AND provider = 'stripe' AND status = 'open' AND upgrade_processed_at IS NULL
    `).bind(new Date().toISOString(), row.id).run();
  }
}

type PixLicense = {
  id: number;
  name: string;
  contact: string;
  customer_id: number | null;
  status: string;
  source: string | null;
  access_type: string;
  plan_tier: string | null;
  expires_at: string;
  billing_current_period_start: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

type PaidCheckout = {
  checkout_evidence_json: string | null;
  operation_type: string | null;
};

export type PixPlanTransition = Awaited<ReturnType<typeof previewPixPlanTransition>>;

export type PixTransitionEvidence = {
  operation: typeof PIX_PLAN_TRANSITION_OPERATION;
  paymentMethod: "card";
  currentTier: PlanTier;
  currentPeriod: RecurringPeriod;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  targetTier: PlanTier;
  targetPeriod: RecurringPeriod;
  targetFullPriceCents: number;
  currentPeriodPriceCents: number;
  unusedPixCreditCents: number;
  amountCents: number;
  timing: PixTransitionTiming;
  nextRenewalAt: string;
  checkoutCollectionMode: "subscription" | "payment" | "setup";
  firstInvoiceSubscription?: boolean;
};

export function parseCardPixTransitionEvidence(value: string | null): PixTransitionEvidence | null {
  try {
    const parsed = JSON.parse(value || "null") as PixTransitionEvidence | null;
    return parsed?.operation === PIX_PLAN_TRANSITION_OPERATION && parsed.paymentMethod === "card"
      && parsed.currentPeriodEnd && parsed.currentPeriodStart && parsed.nextRenewalAt
      && Number.isSafeInteger(parsed.amountCents) && parsed.amountCents >= 0
      ? parsed : null;
  } catch {
    return null;
  }
}

function periodFromAccessType(value: string): RecurringPeriod | null {
  if (value === "monthly_subscription" || value === "monthly_manual") return "monthly";
  if (value === "semiannual_subscription" || value === "semiannual_manual") return "semiannual";
  if (value === "annual_subscription" || value === "annual_manual") return "annual";
  return null;
}

function paidPeriodPrice(checkout: PaidCheckout | null) {
  try {
    const evidence = JSON.parse(checkout?.checkout_evidence_json || "null") as {
      amountCents?: unknown;
      targetFullPriceCents?: unknown;
    } | null;
    const value = checkout?.operation_type === PIX_PLAN_TRANSITION_OPERATION
      ? evidence?.targetFullPriceCents : evidence?.amountCents;
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
  } catch {
    return null;
  }
}

export async function previewPixPlanTransition(c: AppContext, input: {
  licenseId: number;
  targetTier: PlanTier;
  targetPeriod: RecurringPeriod;
  paymentMethod: "pix" | "card";
}) {
  const billing = await getBillingSettings(c);
  if (!billing.plansEnabled || !billing.billingEnabled || !billing.publicSignupEnabled) {
    throw new HTTPException(409, { message: "Alteracoes de plano indisponiveis neste momento." });
  }
  const periodEnabled = input.targetPeriod === "monthly" ? billing.monthlyEnabled
    : input.targetPeriod === "semiannual" ? billing.semiannualEnabled : billing.annualEnabled;
  const pixEnabled = input.targetPeriod === "monthly" ? billing.pixMonthlyEnabled
    : input.targetPeriod === "semiannual" ? billing.pixSemiannualEnabled : billing.pixAnnualEnabled;
  if (!periodEnabled || (input.paymentMethod === "pix" && (!billing.pixEnabled || !pixEnabled))) {
    throw new HTTPException(409, { message: "Plano de destino indisponivel." });
  }

  const license = await c.env.merlin_db.prepare(`
    SELECT id, name, contact, customer_id, status, source, access_type, plan_tier, expires_at,
      billing_current_period_start, stripe_customer_id, stripe_subscription_id
    FROM licenses WHERE id = ? LIMIT 1
  `).bind(input.licenseId).first<PixLicense>();
  const currentPeriod = periodFromAccessType(license?.access_type || "");
  if (!license || !["active", "expired"].includes(license.status) || !currentPeriod || !license.customer_id
    || !String(license.source || "").includes("mercadopago")
    || license.stripe_customer_id || license.stripe_subscription_id) {
    throw new HTTPException(409, { message: "Acesso Pix ativo nao elegivel para esta troca." });
  }

  const scheduled = await c.env.merlin_db.prepare(`
    SELECT id FROM checkout_sessions
    WHERE scheduled_renewal_license_id = ? AND renewal_applied_at IS NULL
      AND (payment_status = 'paid' OR status = 'open') LIMIT 1
  `).bind(license.id).first<{ id: number }>();
  if (scheduled) throw new HTTPException(409, { message: "Ja existe um periodo Pix pago para esta licenca." });

  const currentTier = normalizeStoredPlanTier(license.plan_tier, "ouro");
  const lastPaid = await c.env.merlin_db.prepare(`
    SELECT checkout_evidence_json, operation_type FROM checkout_sessions
    WHERE provider = 'mercadopago' AND license_id = ? AND payment_status = 'paid'
      AND plan_tier = ? AND plan_type = ?
      AND (scheduled_renewal_license_id IS NULL OR renewal_applied_at IS NOT NULL)
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `).bind(license.id, currentTier, currentPeriod).first<PaidCheckout>();
  const paidPriceCents = paidPeriodPrice(lastPaid);
  const expired = Date.parse(license.expires_at) <= Date.now();
  // Checkout must remain open for at least 30 minutes. Stop creating a card
  // migration 30 minutes before the agreed 24-hour cutoff, so payment cannot
  // be initiated after that cutoff while the old Pix period is still active.
  if (input.paymentMethod === "card" && !expired
    && Date.parse(license.expires_at) - Date.now() <= (24 * 60 + 30) * 60_000) {
    throw new HTTPException(409, { message: "A troca de Pix para cartao precisa ser iniciada mais de 24h30 antes do vencimento. Apos vencer, voce podera contratar o cartao normalmente." });
  }
  if ((!license.billing_current_period_start || !paidPriceCents) && !expired) {
    throw new HTTPException(409, { message: "Nao foi possivel conferir o periodo Pix pago. Contate o suporte." });
  }

  const targetPrice = await getBillingPlanPrice(c, input.paymentMethod, input.targetTier, input.targetPeriod,
    { requirePriceId: input.paymentMethod === "card" });
  if (!Number.isSafeInteger(targetPrice.amount_cents) || !targetPrice.amount_cents
    || String(targetPrice.currency || "brl").toLowerCase() !== "brl") {
    throw new HTTPException(409, { message: "Valor de destino indisponivel." });
  }
  const now = new Date().toISOString();
  const currentPeriodPriceCents = paidPriceCents || targetPrice.amount_cents;
  const currentPeriodStart = license.billing_current_period_start
    || (expired ? new Date(Date.parse(license.expires_at) - 1).toISOString() : null);
  if (!currentPeriodStart) throw new HTTPException(409, { message: "Periodo Pix atual indisponivel." });
  let quote;
  try {
    quote = quotePixTransition({
      currentTier,
      currentPeriod,
      currentPeriodPriceCents,
      currentPeriodStart,
      currentPeriodEnd: license.expires_at,
      targetTier: input.targetTier,
      targetPeriod: input.targetPeriod,
      targetPriceCents: targetPrice.amount_cents,
      targetPaymentMethod: input.paymentMethod,
      now,
    });
  } catch (error) {
    throw new HTTPException(409, { message: error instanceof Error ? error.message : "Troca indisponivel." });
  }
  return {
    license: { ...license, billing_current_period_start: currentPeriodStart },
    currentTier,
    currentPeriod,
    currentPeriodPriceCents,
    targetTier: input.targetTier,
    targetPeriod: input.targetPeriod,
    targetPriceId: targetPrice.provider_price_id,
    targetPriceCents: targetPrice.amount_cents,
    paymentMethod: input.paymentMethod,
    currency: "brl" as const,
    ...quote,
  };
}

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams, idempotencyKey: string): Promise<T> {
  const key = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new HTTPException(503, { message: "Stripe nao configurada." });
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: params.toString(),
  });
  const payload = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: payload?.error?.message || "Nao foi possivel abrir o checkout na Stripe." });
  }
  return payload;
}

async function stripeGet<T>(c: AppContext, path: string): Promise<T> {
  const key = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new HTTPException(503, { message: "Stripe nao configurada." });
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
  });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload) throw new HTTPException(502, { message: "Nao foi possivel conferir o checkout anterior na Stripe." });
  return payload;
}

export async function createCardPixTransitionCheckout(c: AppContext, quote: PixPlanTransition) {
  if (quote.paymentMethod !== "card" || !quote.targetPriceId || !quote.license.customer_id) {
    throw new HTTPException(409, { message: "Troca para cartao invalida." });
  }
  if (quote.timing !== "reactivation" && Date.parse(quote.license.expires_at) - Date.now() <= (24 * 60 + 30) * 60_000) {
    throw new HTTPException(409, { message: "O prazo para iniciar esta troca terminou. Apos o vencimento, contrate o cartao normalmente." });
  }
  const now = new Date().toISOString();
  // A paid Pix period is not a free trial. Collect the card in Checkout without
  // presenting the remaining paid time as a promotional trial.
  const checkoutCollectionMode = quote.timing === "reactivation" || quote.timing === "immediate"
    ? "subscription" : "setup";
  await reconcilePriorPixPlanTransitions(c, quote.license.id);
  const existing = await c.env.merlin_db.prepare(`
    SELECT id FROM checkout_sessions WHERE operation_type = ? AND upgrade_license_id = ?
      AND upgrade_processed_at IS NULL AND status NOT IN ('expired', 'failed', 'canceled') LIMIT 1
  `).bind(PIX_PLAN_TRANSITION_OPERATION, quote.license.id).first<{ id: number }>();
  if (existing) throw new HTTPException(409, { message: "Ja existe uma troca de plano em processamento." });

  const reservationId = `pix_card_${crypto.randomUUID()}`;
  const evidence: PixTransitionEvidence = {
    operation: PIX_PLAN_TRANSITION_OPERATION,
    paymentMethod: "card",
    currentTier: quote.currentTier,
    currentPeriod: quote.currentPeriod,
    currentPeriodStart: quote.license.billing_current_period_start!,
    currentPeriodEnd: quote.license.expires_at,
    targetTier: quote.targetTier,
    targetPeriod: quote.targetPeriod,
    targetFullPriceCents: quote.targetPriceCents,
    currentPeriodPriceCents: quote.currentPeriodPriceCents,
    unusedPixCreditCents: quote.unusedPixCreditCents,
    amountCents: quote.amountDueNowCents,
    timing: quote.timing,
    nextRenewalAt: quote.nextRenewalAt,
    checkoutCollectionMode,
    firstInvoiceSubscription: quote.timing === "immediate" || quote.timing === "reactivation",
  };
  try {
    await c.env.merlin_db.prepare(`
      INSERT INTO checkout_sessions (
        customer_id, provider, provider_session_id, provider_price_id, plan_tier, plan_type,
        mode, status, payment_status, operation_type, upgrade_license_id,
        checkout_evidence_json, idempotency_key, provider_session_expires_at, created_at, updated_at
      ) VALUES (?, 'stripe', ?, ?, ?, ?, ?, 'open', 'unpaid', ?, ?, ?, ?, ?, ?, ?)
    `).bind(quote.license.customer_id, reservationId, quote.targetPriceId, quote.targetTier, quote.targetPeriod,
      checkoutCollectionMode, PIX_PLAN_TRANSITION_OPERATION, quote.license.id, JSON.stringify(evidence), reservationId,
      new Date(Date.now() + 30 * 60_000).toISOString(), now, now).run();
  } catch {
    throw new HTTPException(409, { message: "Ja existe uma troca de plano em processamento." });
  }

  let createdSessionId: string | null = null;
  let checkoutRequestStarted = false;
  try {
    const customer = await c.env.merlin_db.prepare(`
      SELECT stripe_customer_id, email FROM customers WHERE id = ? LIMIT 1
    `).bind(quote.license.customer_id).first<{ stripe_customer_id: string | null; email: string }>();
    if (!customer) throw new Error("Customer da licenca nao encontrado");
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const params = new URLSearchParams();
      params.set("email", customer.email);
      params.set("name", quote.license.name);
      params.set("metadata[merlin_customer_id]", String(quote.license.customer_id));
      const created = await stripePost<{ id?: string }>(c, "/customers", params, `${reservationId}:customer`);
      stripeCustomerId = created.id || null;
      if (!stripeCustomerId) throw new Error("Stripe nao retornou o customer");
      await c.env.merlin_db.prepare(`UPDATE customers SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
        .bind(stripeCustomerId, now, quote.license.customer_id).run();
    }

    const origin = getPublicAppOrigin(c);
    const params = new URLSearchParams();
    params.set("mode", checkoutCollectionMode);
    params.set("customer", stripeCustomerId);
    params.set("client_reference_id", String(quote.license.customer_id));
    params.set("payment_method_types[0]", "card");
    if (checkoutCollectionMode === "subscription") {
      params.set("payment_method_collection", "always");
      params.set("line_items[0][price]", quote.targetPriceId);
      params.set("line_items[0][quantity]", "1");
      if (quote.timing === "payment_method_only" || quote.timing === "period_end") {
        params.set("subscription_data[trial_end]", String(Math.floor(Date.parse(quote.nextRenewalAt) / 1000)));
        params.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "create_invoice");
      }
      params.set("subscription_data[metadata][merlin_license_id]", String(quote.license.id));
      params.set("subscription_data[metadata][merlin_operation]", PIX_PLAN_TRANSITION_OPERATION);
      if (quote.timing === "immediate") {
        const firstInvoiceDiscount = quote.targetPriceCents - quote.amountDueNowCents;
        if (firstInvoiceDiscount > 0) {
          const couponParams = new URLSearchParams();
          couponParams.set("amount_off", String(firstInvoiceDiscount));
          couponParams.set("currency", "brl");
          couponParams.set("duration", "once");
          couponParams.set("max_redemptions", "1");
          couponParams.set("name", "Credito Pix Merlin - primeira fatura");
          couponParams.set("metadata[merlin_license_id]", String(quote.license.id));
          const coupon = await stripePost<{ id?: string }>(c, "/coupons", couponParams, `${reservationId}:coupon`);
          if (!coupon.id) throw new Error("Stripe nao retornou o desconto da primeira fatura");
          params.set("discounts[0][coupon]", coupon.id);
        }
      }
    }
    params.set("success_url", `${origin}/meu-acesso?access=plan-change-return&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${origin}/meu-acesso?access=plan-change-cancel`);
    params.set("expires_at", String(Math.floor(Date.now() / 1000) + 30 * 60));
    params.set("metadata[merlin_license_id]", String(quote.license.id));
    params.set("metadata[merlin_operation]", PIX_PLAN_TRANSITION_OPERATION);
    checkoutRequestStarted = true;
    const session = await stripePost<{ id?: string; url?: string; status?: string; expires_at?: number }>(c,
      "/checkout/sessions", params, `${reservationId}:checkout`);
    createdSessionId = session.id || null;
    if (!session.id || !session.url) throw new Error("Stripe nao retornou URL de checkout");
    await c.env.merlin_db.prepare(`
      UPDATE checkout_sessions SET provider_session_id = ?, provider_session_url = ?,
        provider_session_expires_at = ?, status = ?, updated_at = ? WHERE provider_session_id = ?
    `).bind(session.id, session.url, session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      session.status || "open", new Date().toISOString(), reservationId).run();
    return { checkoutUrl: session.url, checkoutSessionId: session.id };
  } catch (error) {
    if (checkoutRequestStarted) {
      // An external Checkout may already be payable. Keep the reservation
      // locked instead of allowing a second Checkout and a double charge.
      console.error("[pix-card-transition] Checkout created but not persisted", {
        licenseId: quote.license.id, checkoutSessionId: createdSessionId, reservationId,
      });
    } else {
      await c.env.merlin_db.prepare(`UPDATE checkout_sessions SET status = 'failed', updated_at = ? WHERE provider_session_id = ?`)
        .bind(new Date().toISOString(), reservationId).run();
    }
    throw error;
  }
}
