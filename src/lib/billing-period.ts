import type { BillingPlanType } from "./billing-settings";

export function billingPeriodMonths(planType: BillingPlanType): number | null {
  if (planType === "monthly") return 1;
  if (planType === "semiannual") return 6;
  if (planType === "annual") return 12;
  return null;
}

/** Advance calendar months without overflowing short months (e.g. 31 Aug -> 28 Feb). */
export function addBillingPeriod(start: string, planType: BillingPlanType): string {
  const months = billingPeriodMonths(planType);
  if (months === null) throw new Error("Lifetime access has no billing period");
  const date = new Date(start);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid billing period start");
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}
