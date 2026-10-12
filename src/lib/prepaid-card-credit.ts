import { addBillingPeriod, billingPeriodMonths } from "./billing-period";
import { PLAN_RULES, type PlanTier } from "./plan-tiers";
import type { PixTransitionEvidence } from "./pix-plan-management";
import type { RecurringPeriod } from "./pix-plan-transition";

export type PrepaidCreditLayer = { amountCents: number; startsAt: string; endsAt: string };

export type PrepaidCardQuote = {
  timing: "immediate" | "early_renewal";
  amountDueNowCents: number;
  unusedCreditCents: number;
  nextRenewalAt: string;
  targetPeriodStart: string;
  layersAfterPayment: PrepaidCreditLayer[];
  prepaidSplitAt: string | null;
};

function validLayer(layer: PrepaidCreditLayer) {
  return Number.isSafeInteger(layer.amountCents) && layer.amountCents >= 0
    && Number.isFinite(Date.parse(layer.startsAt)) && Number.isFinite(Date.parse(layer.endsAt))
    && Date.parse(layer.startsAt) < Date.parse(layer.endsAt);
}

export function remainingCredit(layers: PrepaidCreditLayer[], now: string) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || !layers.length || !layers.every(validLayer)) {
    throw new Error("Historico de pagamentos antecipados invalido.");
  }
  return layers.reduce((sum, layer) => {
    const start = Date.parse(layer.startsAt);
    const end = Date.parse(layer.endsAt);
    return sum + Math.round(layer.amountCents * Math.max(0, Math.min(1, (end - nowMs) / (end - start))));
  }, 0);
}

export function initialPrepaidLayers(evidence: PixTransitionEvidence, completedAt: string): PrepaidCreditLayer[] {
  if (!Number.isSafeInteger(evidence.currentPeriodPriceCents) || evidence.currentPeriodPriceCents <= 0
    || !Number.isSafeInteger(evidence.targetFullPriceCents) || evidence.targetFullPriceCents <= 0) {
    throw new Error("Valor original do Pix indisponivel.");
  }
  const original = { amountCents: evidence.currentPeriodPriceCents,
    startsAt: evidence.currentPeriodStart, endsAt: evidence.currentPeriodEnd };
  if (evidence.timing === "immediate" && evidence.targetPeriod !== evidence.currentPeriod) {
    return [{ amountCents: evidence.targetFullPriceCents, startsAt: completedAt, endsAt: evidence.nextRenewalAt }];
  }
  if (evidence.timing === "early_renewal") {
    const adjustment = evidence.amountCents - evidence.targetFullPriceCents;
    return [original,
      ...(adjustment > 0 ? [{ amountCents: adjustment, startsAt: completedAt, endsAt: evidence.currentPeriodEnd }] : []),
      { amountCents: evidence.targetFullPriceCents, startsAt: evidence.currentPeriodEnd, endsAt: evidence.nextRenewalAt }];
  }
  return [original,
    ...(evidence.amountCents > 0 ? [{ amountCents: evidence.amountCents, startsAt: completedAt, endsAt: evidence.currentPeriodEnd }] : [])];
}

export function quotePrepaidCardChange(input: {
  now: string;
  currentTier: PlanTier;
  currentPeriod: RecurringPeriod;
  currentPriceCents: number;
  targetTier: PlanTier;
  targetPeriod: RecurringPeriod;
  targetPriceCents: number;
  currentRenewalAt: string;
  currentPeriodStart: string;
  prepaidSplitAt?: string | null;
  layers: PrepaidCreditLayer[];
}): PrepaidCardQuote {
  const nowMs = Date.parse(input.now);
  const renewalMs = Date.parse(input.currentRenewalAt);
  const startMs = Date.parse(input.currentPeriodStart);
  if (!Number.isFinite(nowMs) || !Number.isFinite(renewalMs) || !Number.isFinite(startMs)
    || nowMs < startMs || nowMs >= renewalMs
    || !Number.isSafeInteger(input.currentPriceCents) || input.currentPriceCents <= 0
    || !Number.isSafeInteger(input.targetPriceCents) || input.targetPriceCents <= 0) {
    throw new Error("Periodo antecipado indisponivel.");
  }
  const periodDifference = billingPeriodMonths(input.targetPeriod)! - billingPeriodMonths(input.currentPeriod)!;
  const tierDifference = PLAN_RULES[input.targetTier].rank - PLAN_RULES[input.currentTier].rank;
  if (periodDifference < 0 || (periodDifference === 0 && tierDifference <= 0)) {
    throw new Error("Reducao de plano segue a regra de alteracao no vencimento.");
  }
  const credit = remainingCredit(input.layers, input.now);
  const due = input.targetPriceCents - credit;
  if (due < 0) throw new Error("O credito atual supera o valor do plano de destino.");
  const nextRenewalAt = addBillingPeriod(input.now, input.targetPeriod);
  return { timing: "immediate", amountDueNowCents: due < 100 ? 0 : due,
    unusedCreditCents: credit, nextRenewalAt, targetPeriodStart: input.now,
    prepaidSplitAt: null,
    layersAfterPayment: [{ amountCents: input.targetPriceCents, startsAt: input.now, endsAt: nextRenewalAt }] };
}
