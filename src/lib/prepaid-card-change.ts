import { Buffer } from "node:buffer";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { addBillingPeriod } from "./billing-period";
import { getBillingSettings } from "./billing-settings";
import { normalizeStoredPlanTier, type PlanTier } from "./plan-tiers";
import { getCardPlanPrice } from "./subscription-plan-change";
import { parseCardPixTransitionEvidence, PIX_PLAN_TRANSITION_OPERATION } from "./pix-plan-management";
import type { RecurringPeriod } from "./pix-plan-transition";
import { initialPrepaidLayers, quotePrepaidCardChange, type PrepaidCreditLayer } from "./prepaid-card-credit";
import { getPublicAppOrigin } from "./public-origin";

export const PREPAID_CARD_CHANGE_OPERATION = "prepaid_card_plan_change";

type CardLicense = {
  id: number; customer_id: number | null; status: string; source: string | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null;
  plan_tier: string | null; access_type: string; expires_at: string;
  billing_status: string | null; billing_cancel_at_period_end: number | null;
  billing_current_period_start: string | null;
};

type MigrationRow = {
  id: number; checkout_evidence_json: string | null; completed_at: string | null;
  provider_price_id: string | null;
};

export type PrepaidCardEvidence = {
  operation: typeof PREPAID_CARD_CHANGE_OPERATION;
  subscriptionId: string;
  currentTier: PlanTier; currentPeriod: RecurringPeriod; currentPriceCents: number;
  currentPriceId: string; currentRenewalAt: string; currentPeriodStart: string;
  targetTier: PlanTier; targetPeriod: RecurringPeriod; targetPriceCents: number;
  targetPriceId: string; amountDueNowCents: number; unusedCreditCents: number;
  timing: "immediate" | "early_renewal"; nextRenewalAt: string; targetPeriodStart: string;
  prepaidSplitAt?: string | null; creditPeriodStart?: string;
  layersAfterPayment: PrepaidCreditLayer[];
  checkoutMode: "payment" | "setup";
};

export function parsePrepaidCardEvidence(value: string | null): PrepaidCardEvidence | null {
  try {
    const parsed = JSON.parse(value || "null") as PrepaidCardEvidence | null;
    return parsed?.operation === PREPAID_CARD_CHANGE_OPERATION
      && typeof parsed.subscriptionId === "string" && typeof parsed.targetPriceId === "string"
      && Number.isSafeInteger(parsed.amountDueNowCents) && parsed.amountDueNowCents >= 0
      && Array.isArray(parsed.layersAfterPayment) ? parsed : null;
  } catch { return null; }
}

function periodFromAccessType(accessType: string): RecurringPeriod | null {
  if (accessType === "monthly_subscription") return "monthly";
  if (accessType === "semiannual_subscription") return "semiannual";
  if (accessType === "annual_subscription") return "annual";
  return null;
}

function stripeBillingInstant(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(Math.floor(milliseconds / 1000) * 1000).toISOString() : null;
}

function stripeAuth(c: AppContext) {
  const key = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new HTTPException(503, { message: "Stripe indisponivel." });
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function stripeGet<T>(c: AppContext, path: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: stripeAuth(c) } });
  const body = await response.json().catch(() => null) as T | null;
  if (!response.ok || !body) throw new HTTPException(502, { message: "Nao foi possivel conferir a assinatura Stripe." });
  return body;
}

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams, idempotencyKey: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST", headers: { Authorization: stripeAuth(c), "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey }, body: params.toString(),
  });
  const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || !body) throw new HTTPException(502, {
    message: body?.error?.message || "Nao foi possivel concluir a alteracao na Stripe.",
  });
  return body;
}

export async function getPrepaidCardContext(c: AppContext, licenseId: number) {
  const license = await c.env.merlin_db.prepare(`
    SELECT id, customer_id, status, source, stripe_customer_id, stripe_subscription_id,
      plan_tier, access_type, expires_at, billing_status, billing_cancel_at_period_end,
      billing_current_period_start
    FROM licenses WHERE id = ? LIMIT 1
  `).bind(licenseId).first<CardLicense>();
  if (!license?.stripe_subscription_id || license.source !== "stripe") return null;
  const migration = await c.env.merlin_db.prepare(`
    SELECT id, checkout_evidence_json, completed_at, provider_price_id
    FROM checkout_sessions WHERE license_id = ? AND operation_type = ?
      AND provider_subscription_id = ? AND upgrade_processed_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).bind(license.id, PIX_PLAN_TRANSITION_OPERATION, license.stripe_subscription_id).first<MigrationRow>();
  if (!migration) return null;
  const initial = parseCardPixTransitionEvidence(migration.checkout_evidence_json);
  if (!initial || initial.timing === "reactivation" || initial.timing === "period_end"
    || initial.firstInvoiceSubscription) return null;
  const paidFirstCardCycle = await c.env.merlin_db.prepare(`
    SELECT id FROM subscription_plan_changes WHERE license_id = ? AND stripe_subscription_id = ?
      AND change_type = 'prepaid_first_card_invoice' AND status = 'applied' LIMIT 1
  `).bind(license.id, license.stripe_subscription_id).first<{ id: number }>();
  if (paidFirstCardCycle) return null;
  if (license.status !== "active" || !license.customer_id || !license.stripe_customer_id
    || !periodFromAccessType(license.access_type) || license.billing_cancel_at_period_end === 1
    || ["canceled", "unpaid", "past_due", "action_required", "dispute_open"].includes(license.billing_status || "")) {
    throw new HTTPException(409, { message: "A assinatura nao esta elegivel para uma nova alteracao agora." });
  }
  const latest = await c.env.merlin_db.prepare(`
    SELECT checkout_evidence_json, provider_price_id FROM checkout_sessions
    WHERE license_id = ? AND operation_type = ? AND upgrade_subscription_id = ?
      AND upgrade_processed_at IS NOT NULL ORDER BY id DESC LIMIT 1
  `).bind(license.id, PREPAID_CARD_CHANGE_OPERATION, license.stripe_subscription_id)
    .first<{ checkout_evidence_json: string | null; provider_price_id: string | null }>();
  const latestEvidence = latest ? parsePrepaidCardEvidence(latest.checkout_evidence_json) : null;
  if (latest && !latestEvidence) throw new HTTPException(409, { message: "Historico da alteracao anterior indisponivel." });
  if (!latestEvidence && !migration.completed_at) {
    throw new HTTPException(409, { message: "Data da migracao para cartao indisponivel." });
  }
  let layers: PrepaidCreditLayer[];
  try {
    layers = latestEvidence?.layersAfterPayment || initialPrepaidLayers(initial, migration.completed_at!);
  } catch {
    throw new HTTPException(409, { message: "Nao foi possivel conferir o credito ja pago." });
  }
  const currentPeriod = periodFromAccessType(license.access_type)!;
  const currentTier = normalizeStoredPlanTier(license.plan_tier, "ouro");
  const currentPriceCents = latestEvidence?.targetPriceCents || initial.targetFullPriceCents;
  const currentPriceId = latestEvidence?.targetPriceId || migration.provider_price_id;
  const currentRenewalAt = stripeBillingInstant(latestEvidence?.nextRenewalAt || initial.nextRenewalAt);
  if (!currentRenewalAt) throw new HTTPException(409, { message: "Vencimento registrado invalido." });
  if (Date.parse(currentRenewalAt) <= Date.now()) return null;
  const billedPeriodStart = Date.parse(license.billing_current_period_start || "");
  if (Number.isFinite(billedPeriodStart) && billedPeriodStart >= Date.parse(currentRenewalAt)) return null;
  const currentPeriodStart = latestEvidence?.creditPeriodStart || latestEvidence?.targetPeriodStart
    || (initial.timing === "early_renewal" ? initial.currentPeriodStart
      : initial.targetPeriod === initial.currentPeriod ? initial.currentPeriodStart : migration.completed_at!);
  const prepaidSplitAt = latestEvidence
    ? latestEvidence.prepaidSplitAt || null
    : initial.timing === "early_renewal" ? initial.currentPeriodEnd : null;
  if (!currentPriceId || !Number.isSafeInteger(currentPriceCents) || currentPriceCents <= 0
    || currentRenewalAt !== stripeBillingInstant(license.expires_at)) {
    throw new HTTPException(409, { message: "O periodo do cartao nao corresponde ao credito registrado." });
  }
  return { license, initial, latestEvidence, layers, currentTier, currentPeriod,
    currentPriceCents, currentPriceId, currentRenewalAt, currentPeriodStart, prepaidSplitAt };
}

export async function previewPrepaidCardChange(c: AppContext, input: {
  licenseId: number; targetTier: PlanTier; targetPeriod: RecurringPeriod;
}) {
  const context = await getPrepaidCardContext(c, input.licenseId);
  if (!context) throw new HTTPException(409, { message: "Periodo antecipado nao encontrado." });
  const billing = await getBillingSettings(c);
  const periodEnabled = input.targetPeriod === "monthly" ? billing.monthlyEnabled
    : input.targetPeriod === "semiannual" ? billing.semiannualEnabled : billing.annualEnabled;
  if (!billing.billingEnabled || !billing.plansEnabled || !periodEnabled) {
    throw new HTTPException(409, { message: "Plano de destino indisponivel." });
  }
  const price = await getCardPlanPrice(c, input.targetTier, input.targetPeriod);
  if (!price.provider_price_id || !Number.isSafeInteger(price.amount_cents) || !price.amount_cents
    || String(price.currency || "brl").toLowerCase() !== "brl") {
    throw new HTTPException(409, { message: "Preco do plano de destino indisponivel." });
  }
  let quote;
  try {
    quote = quotePrepaidCardChange({
      now: stripeBillingInstant(new Date().toISOString())!, currentTier: context.currentTier, currentPeriod: context.currentPeriod,
      currentPriceCents: context.currentPriceCents, targetTier: input.targetTier,
      targetPeriod: input.targetPeriod, targetPriceCents: price.amount_cents,
      currentRenewalAt: context.currentRenewalAt, currentPeriodStart: context.currentPeriodStart,
      prepaidSplitAt: context.prepaidSplitAt,
      layers: context.layers,
    });
  } catch (error) {
    throw new HTTPException(409, { message: error instanceof Error ? error.message : "Nao foi possivel calcular a alteracao." });
  }
  const periodGrows = input.targetPeriod !== context.currentPeriod;
  const changeType = periodGrows ? "interval_change" as const : "upgrade" as const;
  return {
    ...quote, context, currentTier: context.currentTier, currentPeriod: context.currentPeriod,
    targetTier: input.targetTier, targetPeriod: input.targetPeriod,
    targetAmountCents: price.amount_cents, targetCurrency: "brl" as const,
    targetPriceId: price.provider_price_id, changeType,
    requiresPaymentConfirmation: true, prorationDate: null,
  };
}

async function assertStripePrepaidState(c: AppContext, context: NonNullable<Awaited<ReturnType<typeof getPrepaidCardContext>>>) {
  const subscription = await stripeGet<{
    id?: string; customer?: string; status?: string; trial_end?: number | null;
    pending_update?: unknown;
    cancel_at_period_end?: boolean; items?: { data?: Array<{ id?: string; price?: { id?: string } }> };
  }>(c, `/subscriptions/${encodeURIComponent(context.license.stripe_subscription_id!)}?expand%5B%5D=items.data.price`);
  const item = subscription.items?.data?.[0];
  if (subscription.id !== context.license.stripe_subscription_id
    || subscription.customer !== context.license.stripe_customer_id
    || subscription.status !== "trialing" || subscription.cancel_at_period_end || subscription.pending_update
    || !item?.id || item.price?.id !== context.currentPriceId
    || Number(subscription.trial_end) !== Date.parse(context.currentRenewalAt) / 1000) {
    throw new HTTPException(409, { message: "A assinatura mudou na Stripe. Atualize seu acesso antes de tentar novamente." });
  }
  return item;
}

export async function settleOpenPrepaidCardCheckouts(c: AppContext, licenseId: number) {
  const previous = await c.env.merlin_db.prepare(`
    SELECT id, provider_session_id FROM checkout_sessions
    WHERE operation_type = ? AND upgrade_license_id = ? AND status = 'open'
      AND upgrade_processed_at IS NULL
  `).bind(PREPAID_CARD_CHANGE_OPERATION, licenseId)
    .all<{ id: number; provider_session_id: string }>();
  for (const row of previous.results || []) {
    if (!row.provider_session_id?.startsWith("cs_")) {
      throw new HTTPException(409, { message: "Um checkout anterior precisa de conciliacao." });
    }
    const sessionPath = `/checkout/sessions/${encodeURIComponent(row.provider_session_id)}`;
    let stripeStatus = (await stripeGet<{ status?: string }>(c, sessionPath)).status;
    if (stripeStatus === "open") {
      try {
        stripeStatus = (await stripePost<{ status?: string }>(c, `${sessionPath}/expire`,
          new URLSearchParams(), `merlin_expire:${row.provider_session_id}`)).status;
      } catch {
        // A payment could complete after the GET but before the expiration.
        // Keep the reservation unless Stripe confirms it is expired.
        stripeStatus = (await stripeGet<{ status?: string }>(c, sessionPath)).status;
      }
    }
    if (stripeStatus === "complete") {
      const { reconcileStripeCheckoutSession } = await import("./stripe-webhook");
      await reconcileStripeCheckoutSession(c, row.provider_session_id);
      throw new HTTPException(409, { message: "O checkout anterior foi concluido. Atualize seu acesso." });
    }
    if (stripeStatus !== "expired") throw new HTTPException(409, {
      message: "Nao foi possivel encerrar o checkout anterior na Stripe. Tente novamente em instantes.",
    });
    await c.env.merlin_db.prepare(`
      UPDATE checkout_sessions SET status = 'expired', updated_at = ?
      WHERE id = ? AND status = 'open' AND upgrade_processed_at IS NULL
    `).bind(new Date().toISOString(), row.id).run();
  }
  const existing = await c.env.merlin_db.prepare(`
    SELECT id FROM checkout_sessions WHERE operation_type = ? AND upgrade_license_id = ?
      AND upgrade_processed_at IS NULL AND status NOT IN ('expired', 'failed', 'canceled') LIMIT 1
  `).bind(PREPAID_CARD_CHANGE_OPERATION, licenseId).first<{ id: number }>();
  if (existing) throw new HTTPException(409, { message: "Ja existe um checkout de alteracao em andamento." });
}

export async function createPrepaidCardChangeCheckout(c: AppContext, input: {
  licenseId: number; targetTier: PlanTier; targetPeriod: RecurringPeriod;
  returnPath?: string;
}) {
  const preview = await previewPrepaidCardChange(c, input);
  const { context } = preview;
  if (Date.parse(context.currentRenewalAt) - Date.now() <= (24 * 60 + 30) * 60_000) {
    throw new HTTPException(409, { message: "Essa troca pode ser feita ate 24 horas antes da renovacao. Aguarde a renovacao para alterar pelo cartao." });
  }
  const pending = await c.env.merlin_db.prepare(`
    SELECT id FROM subscription_plan_changes WHERE license_id = ?
      AND status IN ('pending_payment', 'payment_action_required', 'scheduled') LIMIT 1
  `).bind(context.license.id).first<{ id: number }>();
  if (pending) throw new HTTPException(409, { message: "Ja existe uma alteracao de plano em andamento." });
  await assertStripePrepaidState(c, context);

  await settleOpenPrepaidCardCheckouts(c, context.license.id);
  const now = new Date().toISOString();

  const reservationId = `prepaid_card_${crypto.randomUUID()}`;
  const checkoutMode = preview.amountDueNowCents > 0 ? "payment" as const : "setup" as const;
  const evidence: PrepaidCardEvidence = {
    operation: PREPAID_CARD_CHANGE_OPERATION,
    subscriptionId: context.license.stripe_subscription_id!,
    currentTier: context.currentTier, currentPeriod: context.currentPeriod,
    currentPriceCents: context.currentPriceCents, currentPriceId: context.currentPriceId,
    currentRenewalAt: context.currentRenewalAt, currentPeriodStart: context.currentPeriodStart,
    targetTier: input.targetTier, targetPeriod: input.targetPeriod,
    targetPriceCents: preview.targetAmountCents, targetPriceId: preview.targetPriceId,
    amountDueNowCents: preview.amountDueNowCents, unusedCreditCents: preview.unusedCreditCents,
    timing: preview.timing, nextRenewalAt: preview.nextRenewalAt,
    targetPeriodStart: preview.targetPeriodStart, prepaidSplitAt: context.prepaidSplitAt,
    creditPeriodStart: context.currentPeriodStart, layersAfterPayment: preview.layersAfterPayment,
    checkoutMode,
  };
  try {
    await c.env.merlin_db.prepare(`
      INSERT INTO checkout_sessions (customer_id, provider, provider_session_id, provider_price_id,
        plan_tier, plan_type, mode, status, payment_status, operation_type, upgrade_license_id,
        upgrade_subscription_id, checkout_evidence_json, idempotency_key,
        provider_session_expires_at, created_at, updated_at)
      VALUES (?, 'stripe', ?, ?, ?, ?, ?, 'open', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(context.license.customer_id, reservationId, preview.targetPriceId,
      input.targetTier, input.targetPeriod, checkoutMode, PREPAID_CARD_CHANGE_OPERATION,
      context.license.id, context.license.stripe_subscription_id, JSON.stringify(evidence),
      reservationId, new Date(Date.now() + 30 * 60_000).toISOString(), now, now).run();
  } catch {
    throw new HTTPException(409, { message: "Ja existe um checkout de alteracao em andamento." });
  }

  let checkoutRequestStarted = false;
  let createdSessionId: string | null = null;
  try {
    const params = new URLSearchParams();
    const origin = getPublicAppOrigin(c);
    params.set("mode", checkoutMode);
    params.set("customer", context.license.stripe_customer_id!);
    params.set("client_reference_id", String(context.license.customer_id));
    params.set("payment_method_types[0]", "card");
    if (checkoutMode === "payment") {
      params.set("line_items[0][price_data][currency]", "brl");
      params.set("line_items[0][price_data][unit_amount]", String(preview.amountDueNowCents));
      params.set("line_items[0][price_data][product_data][name]", "Alteracao de plano Merlin");
      params.set("line_items[0][quantity]", "1");
      params.set("payment_intent_data[setup_future_usage]", "off_session");
    }
    params.set("success_url", `${origin}/meu-acesso?access=plan-change-return&session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${origin}/meu-acesso?access=plan-change-cancel`);
    params.set("expires_at", String(Math.floor(Date.now() / 1000) + 30 * 60));
    params.set("metadata[merlin_license_id]", String(context.license.id));
    params.set("metadata[merlin_operation]", PREPAID_CARD_CHANGE_OPERATION);
    checkoutRequestStarted = true;
    const session = await stripePost<{ id?: string; url?: string; status?: string; expires_at?: number }>(c,
      "/checkout/sessions", params, `${reservationId}:checkout`);
    createdSessionId = session.id || null;
    if (!session.id || !session.url) throw new Error("Stripe nao retornou URL de checkout.");
    await c.env.merlin_db.prepare(`
      UPDATE checkout_sessions SET provider_session_id = ?, provider_session_url = ?,
        provider_session_expires_at = ?, status = ?, updated_at = ? WHERE provider_session_id = ?
    `).bind(session.id, session.url, session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      session.status || "open", new Date().toISOString(), reservationId).run();
    return { status: "pending_payment" as const, checkoutUrl: session.url,
      amountDueNowCents: preview.amountDueNowCents, nextRenewalAt: preview.nextRenewalAt };
  } catch (error) {
    if (checkoutRequestStarted) {
      console.error("[prepaid-card-change] Checkout may need reconciliation", {
        licenseId: context.license.id, checkoutSessionId: createdSessionId, reservationId,
      });
    } else {
      await c.env.merlin_db.prepare(`
        UPDATE checkout_sessions SET status = 'failed', updated_at = ? WHERE provider_session_id = ?
      `).bind(new Date().toISOString(), reservationId).run();
    }
    throw error;
  }
}

export async function applyPrepaidCardChange(c: AppContext, input: {
  checkoutId: number; sessionId: string; customerId: number; stripeCustomerId: string; licenseId: number;
  evidence: PrepaidCardEvidence; completedAt: string; paymentMethodId: string | null;
  paymentIntentId: string | null;
}) {
  const evidence = input.evidence;
  const license = await c.env.merlin_db.prepare(`
    SELECT id, source, status, customer_id, stripe_customer_id, stripe_subscription_id, plan_tier,
      access_type, expires_at FROM licenses WHERE id = ? LIMIT 1
  `).bind(input.licenseId).first<{ id: number; source: string; status: string; customer_id: number;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null; plan_tier: string; access_type: string; expires_at: string }>();
  if (!license || license.source !== "stripe" || license.status !== "active"
    || license.customer_id !== input.customerId || license.stripe_customer_id !== input.stripeCustomerId
    || license.stripe_subscription_id !== evidence.subscriptionId) {
    throw new Error(`Prepaid card checkout ${input.checkoutId} no longer matches its license`);
  }
  const targetAccessType = evidence.targetPeriod === "annual" ? "annual_subscription"
    : evidence.targetPeriod === "semiannual" ? "semiannual_subscription" : "monthly_subscription";
  const targetPeriodStart = stripeBillingInstant(input.completedAt);
  if (!targetPeriodStart) throw new Error(`Prepaid card checkout ${input.checkoutId} has invalid completion time`);
  const nextRenewalAt = addBillingPeriod(targetPeriodStart, evidence.targetPeriod);
  const layers = [{ amountCents: evidence.targetPriceCents,
    startsAt: targetPeriodStart, endsAt: nextRenewalAt }];
  const settledEvidence = { ...evidence, nextRenewalAt, targetPeriodStart, layersAfterPayment: layers,
    prepaidSplitAt: null, creditPeriodStart: targetPeriodStart };
  const currentAccessType = evidence.currentPeriod === "annual" ? "annual_subscription"
    : evidence.currentPeriod === "semiannual" ? "semiannual_subscription" : "monthly_subscription";
  const expectedCurrentRenewalAt = stripeBillingInstant(evidence.currentRenewalAt);
  const actualRenewalAt = stripeBillingInstant(license.expires_at);
  const alreadyApplied = license.plan_tier === evidence.targetTier && license.access_type === targetAccessType
    && actualRenewalAt === nextRenewalAt;
  if (!alreadyApplied && (license.plan_tier !== evidence.currentTier
    || license.access_type !== currentAccessType
    || !expectedCurrentRenewalAt || actualRenewalAt !== expectedCurrentRenewalAt)) {
    throw new Error(`Prepaid card checkout ${input.checkoutId} has stale plan details`);
  }
  const subscription = await stripeGet<{
    id?: string; status?: string; trial_end?: number | null; customer?: string;
    items?: { data?: Array<{ id?: string; price?: { id?: string } }> };
  }>(c, `/subscriptions/${encodeURIComponent(evidence.subscriptionId)}?expand%5B%5D=items.data.price`);
  const item = subscription.items?.data?.[0];
  if (subscription.id !== evidence.subscriptionId || subscription.customer !== input.stripeCustomerId
    || !item?.id || subscription.status !== "trialing"
    || (item.price?.id !== evidence.currentPriceId && item.price?.id !== evidence.targetPriceId)) {
    throw new Error(`Prepaid card checkout ${input.checkoutId} subscription changed unexpectedly`);
  }
  const trialEndSeconds = Number(subscription.trial_end);
  if (item.price?.id === evidence.currentPriceId
    && trialEndSeconds !== Date.parse(expectedCurrentRenewalAt || "") / 1000) {
    throw new Error(`Prepaid card checkout ${input.checkoutId} renewal date changed`);
  }
  if (item.price?.id !== evidence.targetPriceId
    || trialEndSeconds !== Date.parse(nextRenewalAt) / 1000) {
    const params = new URLSearchParams();
    params.set("items[0][id]", item.id);
    params.set("items[0][price]", evidence.targetPriceId);
    params.set("proration_behavior", "none");
    params.set("trial_end", String(Math.floor(Date.parse(nextRenewalAt) / 1000)));
    if (input.paymentMethodId) params.set("default_payment_method", input.paymentMethodId);
    const updated = await stripePost<{ id?: string; status?: string; trial_end?: number | null;
      items?: { data?: Array<{ price?: { id?: string } }> } }>(c,
      `/subscriptions/${encodeURIComponent(evidence.subscriptionId)}`, params,
      `merlin_prepaid_card:${input.sessionId}:subscription`);
    if (updated.id !== evidence.subscriptionId || updated.status !== "trialing"
      || updated.items?.data?.[0]?.price?.id !== evidence.targetPriceId
      || Number(updated.trial_end) !== Date.parse(nextRenewalAt) / 1000) {
      throw new Error(`Prepaid card checkout ${input.checkoutId} subscription update unconfirmed`);
    }
  }
  const now = new Date().toISOString();
  const result = await c.env.merlin_db.prepare(`
    UPDATE licenses SET plan_tier = ?, access_type = ?, expires_at = ?,
      billing_current_period_start = ?, billing_current_period_end = ?, updated_at = ?
    WHERE id = ? AND source = 'stripe' AND stripe_subscription_id = ?
      AND plan_tier = ? AND access_type = ? AND expires_at = ?
  `).bind(evidence.targetTier, targetAccessType, nextRenewalAt, targetPeriodStart,
    nextRenewalAt, now, license.id, evidence.subscriptionId,
    evidence.currentTier, currentAccessType, license.expires_at).run();
  if (!result.meta.changes && !alreadyApplied) {
    throw new Error(`Prepaid card checkout ${input.checkoutId} license update was not applied`);
  }
  await c.env.merlin_db.prepare(`
    UPDATE subscriptions SET current_period_end = ?, status = 'trialing', updated_at = ?
    WHERE license_id = ? AND provider = 'stripe' AND provider_subscription_id = ?
  `).bind(nextRenewalAt, now, license.id, evidence.subscriptionId).run();
  if (evidence.amountDueNowCents > 0) {
    await c.env.merlin_db.prepare(`
      INSERT OR IGNORE INTO payments (customer_id, license_id, provider, provider_payment_id,
        provider_checkout_session_id, provider_subscription_id, amount_cents, currency, status,
        payment_type, created_at) VALUES (?, ?, 'stripe', ?, ?, ?, ?, 'brl', 'paid', 'one_time', ?)
    `).bind(input.customerId, license.id, input.paymentIntentId, input.sessionId,
      evidence.subscriptionId, evidence.amountDueNowCents, now).run();
  }
  await c.env.merlin_db.prepare(`
    UPDATE checkout_sessions SET license_id = ?, upgrade_subscription_id = ?,
      checkout_evidence_json = ?, upgrade_processed_at = ?, status = 'completed',
      payment_status = ?, updated_at = ? WHERE id = ? AND upgrade_processed_at IS NULL
  `).bind(license.id, evidence.subscriptionId, JSON.stringify(settledEvidence), now,
    evidence.amountDueNowCents > 0 ? "paid" : "no_payment_required", now, input.checkoutId).run();
}
