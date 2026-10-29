import type { AppContext } from "../types";
import { normalizeStoredPlanTier } from "./plan-tiers";

export type FinanceLicenseRow = {
  id: number;
  name: string;
  source: string | null;
  access_type: string | null;
  billing_status: string | null;
  plan_tier: string | null;
  expires_at: string;
  billing_current_period_end: string | null;
  billing_cancel_at_period_end: number | null;
  stripe_subscription_id: string | null;
  has_confirmed_payment: number;
};

type PriceRow = {
  payment_method: string;
  billing_period: string;
  plan_tier: string;
  amount_cents: number | null;
};

type ReceiptRow = {
  provider: string;
  payment_type: string;
  amount_cents: number;
  payment_count: number;
};

type ReconciliationRow = { unmatched_paid_checkouts: number };

export type PayerCategory = "card_auto" | "card_ending" | "pix" | "lifetime" | "attention";
type Period = "monthly" | "semiannual" | "annual" | "lifetime";

export function classifyPayer(row: FinanceLicenseRow): PayerCategory | null {
  const hasCard = Boolean(row.stripe_subscription_id);
  const isPix = row.source === "mercadopago_pix" && !hasCard;
  const isPaidLifetime = row.access_type === "paid_lifetime";
  if (!hasCard && !isPix && !isPaidLifetime) return null;
  if (row.billing_status !== "active" || row.has_confirmed_payment !== 1) return "attention";
  if (hasCard) return row.billing_cancel_at_period_end ? "card_ending" : "card_auto";
  return isPix ? "pix" : "lifetime";
}

export function financePeriod(accessType: string | null): Period {
  if (accessType === "paid_lifetime") return "lifetime";
  if (accessType === "annual_subscription" || accessType === "annual_manual") return "annual";
  if (accessType === "semiannual_subscription" || accessType === "semiannual_manual") return "semiannual";
  return "monthly";
}

export function summarizeFinance(
  licenses: FinanceLicenseRow[],
  prices: PriceRow[],
  receipts: ReceiptRow[],
  pendingChangeIds: Set<number>,
  now = new Date(),
) {
  const nowMs = now.getTime();
  const forecastEndMs = nowMs + 30 * 86400000;
  const priceMap = new Map(prices.map((price) => [
    `${price.payment_method}:${price.billing_period}:${price.plan_tier}`,
    price.amount_cents,
  ]));
  const summary = {
    activeAccess: licenses.length,
    paidActive: 0,
    cardAutomatic: 0,
    cardEnding: 0,
    pixManual: 0,
    paidLifetime: 0,
    paymentAttention: 0,
    receivedCents: 0,
    receivedCount: 0,
    receivedStripeCents: 0,
    receivedPixCents: 0,
    nextCardCents: 0,
    nextCardCount: 0,
    nextPixPotentialCents: 0,
    nextPixPotentialCount: 0,
    unpricedRenewals: 0,
    pendingChangeRenewals: 0,
  };

  const payers = licenses.flatMap((row) => {
    const category = classifyPayer(row);
    if (!category) return [];
    const period = financePeriod(row.access_type);
    const tier = normalizeStoredPlanTier(row.plan_tier, "ouro");
    const paymentMethod = category === "pix" || (category === "attention" && row.source === "mercadopago_pix" && !row.stripe_subscription_id) ? "pix" : "card";
    const priceKey = `${paymentMethod}:${period}:${tier}`;
    const amountCents = period === "lifetime" ? null : priceMap.get(priceKey) ?? null;
    const nextDueAt = period === "lifetime" ? null : row.billing_current_period_end || row.expires_at;
    const dueMs = nextDueAt ? Date.parse(nextDueAt) : NaN;
    const dueSoon = Number.isFinite(dueMs) && dueMs > nowMs && dueMs <= forecastEndMs;

    if (category === "attention") summary.paymentAttention += 1;
    else summary.paidActive += 1;
    if (category === "card_auto") summary.cardAutomatic += 1;
    if (category === "card_ending") summary.cardEnding += 1;
    if (category === "pix") summary.pixManual += 1;
    if (category === "lifetime") summary.paidLifetime += 1;

    if (dueSoon && (category === "card_auto" || category === "pix")) {
      if (pendingChangeIds.has(row.id)) summary.pendingChangeRenewals += 1;
      else if (amountCents === null) summary.unpricedRenewals += 1;
      else if (category === "card_auto") {
        summary.nextCardCents += amountCents;
        summary.nextCardCount += 1;
      } else {
        summary.nextPixPotentialCents += amountCents;
        summary.nextPixPotentialCount += 1;
      }
    }

    return [{
      licenseId: row.id,
      name: row.name,
      category,
      tier,
      period,
      paymentMethod: period === "lifetime" ? "one_time" : paymentMethod,
      billingStatus: row.billing_status || "none",
      attentionReason: category === "attention"
        ? row.has_confirmed_payment !== 1 ? "Sem pagamento confirmado" : `Cobrança: ${row.billing_status || "sem status"}`
        : null,
      nextDueAt,
      amountCents,
      hasPendingChange: pendingChangeIds.has(row.id),
    }];
  });

  for (const receipt of receipts) {
    const amount = Number(receipt.amount_cents) || 0;
    const count = Number(receipt.payment_count) || 0;
    summary.receivedCents += amount;
    summary.receivedCount += count;
    if (receipt.provider === "stripe") summary.receivedStripeCents += amount;
    if (receipt.provider === "mercadopago") summary.receivedPixCents += amount;
  }

  return { summary, payers: payers.sort((a, b) => (a.nextDueAt || "9999").localeCompare(b.nextDueAt || "9999") || a.licenseId - b.licenseId) };
}

export async function getAdminFinanceDashboard(c: AppContext, days = 30) {
  const periodDays = [30, 90, 365].includes(days) ? days : 30;
  const now = new Date();
  const nowIso = now.toISOString();
  const startIso = new Date(now.getTime() - periodDays * 86400000).toISOString();
  const licenseRows = await c.env.merlin_db.prepare(`
    SELECT l.id,l.name,l.source,l.access_type,l.billing_status,l.plan_tier,l.expires_at,
      l.billing_current_period_end,l.billing_cancel_at_period_end,l.stripe_subscription_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM payments p WHERE p.license_id=l.id AND p.status='paid'
      ) OR EXISTS (
        SELECT 1 FROM checkout_sessions cs
        WHERE (cs.license_id=l.id OR cs.reactivation_license_id=l.id)
          AND cs.payment_status='paid'
      ) THEN 1 ELSE 0 END AS has_confirmed_payment
    FROM licenses l
    WHERE COALESCE(l.license_type,'normal') <> 'test'
      AND l.status <> 'revoked' AND l.expires_at > ?
    ORDER BY l.id
  `).bind(nowIso).all<FinanceLicenseRow>();
  const priceRows = await c.env.merlin_db.prepare(`
    SELECT payment_method,billing_period,plan_tier,amount_cents
    FROM billing_plan_prices WHERE provider='stripe' AND active=1
  `).all<PriceRow>();
  const receiptRows = await c.env.merlin_db.prepare(`
    SELECT provider,payment_type,SUM(amount_cents) AS amount_cents,COUNT(*) AS payment_count
    FROM payments
    WHERE status='paid' AND currency='brl' AND created_at >= ? AND created_at <= ?
    GROUP BY provider,payment_type
  `).bind(startIso, nowIso).all<ReceiptRow>();
  const reconciliationRow = await c.env.merlin_db.prepare(`
    SELECT COUNT(*) AS unmatched_paid_checkouts
    FROM checkout_sessions cs
    WHERE cs.provider='stripe' AND cs.payment_status='paid'
      AND cs.completed_at >= ? AND cs.completed_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.provider='stripe' AND p.provider_checkout_session_id=cs.provider_session_id
      )
  `).bind(startIso, nowIso).first<ReconciliationRow>();
  const pendingRows = await c.env.merlin_db.prepare(`
    SELECT DISTINCT license_id FROM subscription_plan_changes
    WHERE status IN ('pending_payment','payment_action_required','payment_failed','scheduled')
  `).all<{ license_id: number }>();
  const result = summarizeFinance(
    licenseRows.results,
    priceRows.results,
    receiptRows.results,
    new Set(pendingRows.results.map((row) => row.license_id)),
    now,
  );
  return {
    generatedAt: nowIso,
    periodDays,
    reconciliation: { unmatchedPaidCheckouts: reconciliationRow?.unmatched_paid_checkouts || 0 },
    ...result,
  };
}
