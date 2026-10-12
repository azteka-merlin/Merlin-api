import { addBillingPeriod, billingPeriodMonths } from "./billing-period";
import { PLAN_RULES, type PlanTier } from "./plan-tiers";
import type { BillingPlanType } from "./billing-settings";

export type RecurringPeriod = Exclude<BillingPlanType, "lifetime">;
export type PixTransitionTiming = "immediate" | "period_end" | "payment_method_only" | "early_renewal" | "reactivation";

export type PixTransitionQuote = {
  timing: PixTransitionTiming;
  amountDueNowCents: number;
  unusedPixCreditCents: number;
  effectiveAt: string;
  nextRenewalAt: string;
};

/**
 * Prices here are snapshots of the amount paid for the CURRENT Pix period and
 * the currently offered target price. Never infer the paid price from today's
 * catalogue: an old purchase may have had a different price.
 */
export function quotePixTransition(input: {
  currentTier: PlanTier;
  currentPeriod: RecurringPeriod;
  currentPeriodPriceCents: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  targetTier: PlanTier;
  targetPeriod: RecurringPeriod;
  targetPriceCents: number;
  targetPaymentMethod: "pix" | "card";
  now: string;
  downgradeWindowDays?: number;
}): PixTransitionQuote {
  const nowMs = Date.parse(input.now);
  const startMs = Date.parse(input.currentPeriodStart);
  const endMs = Date.parse(input.currentPeriodEnd);
  if (![nowMs, startMs, endMs].every(Number.isFinite) || startMs >= endMs || nowMs < startMs) {
    throw new Error("Current Pix billing period is invalid or expired");
  }
  if (!Number.isSafeInteger(input.currentPeriodPriceCents) || input.currentPeriodPriceCents < 0
    || !Number.isSafeInteger(input.targetPriceCents) || input.targetPriceCents <= 0) {
    throw new Error("Pix transition prices are invalid");
  }

  const currentMonths = billingPeriodMonths(input.currentPeriod)!;
  const targetMonths = billingPeriodMonths(input.targetPeriod)!;
  const tierChange = PLAN_RULES[input.targetTier].rank - PLAN_RULES[input.currentTier].rank;
  const periodChange = targetMonths - currentMonths;
  if (nowMs >= endMs) {
    return {
      timing: "reactivation",
      amountDueNowCents: input.targetPriceCents,
      unusedPixCreditCents: 0,
      effectiveAt: input.now,
      nextRenewalAt: addBillingPeriod(input.now, input.targetPeriod),
    };
  }
  const remainingFraction = (endMs - nowMs) / (endMs - startMs);
  const unusedPixCreditCents = Math.min(input.currentPeriodPriceCents,
    Math.max(0, Math.round(input.currentPeriodPriceCents * remainingFraction)));

  if (tierChange === 0 && periodChange === 0) {
    if (input.targetPaymentMethod === "pix") throw new Error("No plan change requested");
    return {
      timing: "payment_method_only",
      amountDueNowCents: 0,
      unusedPixCreditCents,
      effectiveAt: input.now,
      nextRenewalAt: input.currentPeriodEnd,
    };
  }

  if (input.targetPaymentMethod === "card" && (periodChange > 0 || (periodChange === 0 && tierChange > 0))) {
    // This is the first invoice of a real recurring subscription, not an
    // adjustment followed by another invoice on the old Pix due date.
    const due = input.targetPriceCents - unusedPixCreditCents;
    if (due < 0) throw new Error("O credito Pix supera o valor do plano de destino.");
    return {
      timing: "immediate",
      amountDueNowCents: due < 100 ? 0 : due,
      unusedPixCreditCents,
      effectiveAt: input.now,
      nextRenewalAt: addBillingPeriod(input.now, input.targetPeriod),
    };
  }

  if (periodChange > 0) {
    // A longer prepaid period begins on payment confirmation, even if the
    // selected tier is lower. The unused value of the old period is credited.
    const amountDueNowCents = input.targetPriceCents - unusedPixCreditCents;
    if (amountDueNowCents <= 0) throw new Error("Target period costs no more than unused Pix credit");
    return {
      timing: "immediate",
      amountDueNowCents,
      unusedPixCreditCents,
      effectiveAt: input.now,
      nextRenewalAt: addBillingPeriod(input.now, input.targetPeriod),
    };
  }

  if (periodChange === 0 && tierChange > 0) {
    const difference = input.targetPriceCents - input.currentPeriodPriceCents;
    if (difference <= 0) throw new Error("Target tier does not cost more than current tier");
    const amountDueNowCents = Math.max(1, Math.round(difference * remainingFraction));
    return {
      timing: "immediate",
      // A tiny card adjustment is waived; the full target tier is collected
      // on the unchanged renewal date. Pix still needs a payable order.
      amountDueNowCents: input.targetPaymentMethod === "card" && amountDueNowCents < 100
        ? 0 : amountDueNowCents,
      unusedPixCreditCents,
      effectiveAt: input.now,
      nextRenewalAt: input.currentPeriodEnd,
    };
  }

  const daysBeforeExpiry = (endMs - nowMs) / 86_400_000;
  if (daysBeforeExpiry > (input.downgradeWindowDays ?? 7)) {
    throw new Error("Downgrade is only available near the current Pix expiration");
  }
  return {
    timing: "period_end",
    amountDueNowCents: input.targetPaymentMethod === "pix" ? input.targetPriceCents : 0,
    unusedPixCreditCents: 0,
    effectiveAt: input.currentPeriodEnd,
    nextRenewalAt: input.targetPaymentMethod === "card"
      ? input.currentPeriodEnd
      : addBillingPeriod(input.currentPeriodEnd, input.targetPeriod),
  };
}
