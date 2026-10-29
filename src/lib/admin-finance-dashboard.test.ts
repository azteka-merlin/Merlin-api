import { describe, expect, it } from "vitest";
import { classifyPayer, summarizeFinance, type FinanceLicenseRow } from "./admin-finance-dashboard";

const now = new Date("2026-10-28T12:00:00.000Z");

function license(id: number, patch: Partial<FinanceLicenseRow> = {}): FinanceLicenseRow {
  return {
    id,
    name: `Licença ${id}`,
    source: "mercadopago_pix",
    access_type: "monthly_subscription",
    billing_status: "active",
    plan_tier: "bronze",
    expires_at: "2026-11-10T12:00:00.000Z",
    billing_current_period_end: "2026-11-10T12:00:00.000Z",
    billing_cancel_at_period_end: 1,
    stripe_subscription_id: null,
    has_confirmed_payment: 1,
    ...patch,
  };
}

const prices = [
  { payment_method: "pix", billing_period: "monthly", plan_tier: "bronze", amount_cents: 1490 },
  { payment_method: "card", billing_period: "monthly", plan_tier: "bronze", amount_cents: 1490 },
  { payment_method: "card", billing_period: "annual", plan_tier: "ouro", amount_cents: 19990 },
];

describe("admin finance dashboard", () => {
  it("separates Pix manual from Stripe even though both can use monthly_subscription", () => {
    expect(classifyPayer(license(1))).toBe("pix");
    expect(classifyPayer(license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0 }))).toBe("card_auto");
    expect(classifyPayer(license(3, { source: "stripe", stripe_subscription_id: "sub_3", billing_cancel_at_period_end: 1 }))).toBe("card_ending");
    expect(classifyPayer(license(4, { source: "admin", access_type: "legacy_lifetime", billing_status: "none" }))).toBeNull();
    expect(classifyPayer(license(5, { source: "stripe", access_type: "paid_lifetime", stripe_subscription_id: null }))).toBe("lifetime");
    expect(classifyPayer(license(6, { billing_status: "past_due" }))).toBe("attention");
    expect(classifyPayer(license(7, { source: "stripe", stripe_subscription_id: "sub_trial", has_confirmed_payment: 0 }))).toBe("attention");
  });

  it("projects only due automatic card charges and keeps Pix as a separate opportunity", () => {
    const result = summarizeFinance([
      license(1),
      license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0 }),
      license(3, { source: "stripe", stripe_subscription_id: "sub_3", billing_cancel_at_period_end: 1 }),
      license(4, { source: "stripe", stripe_subscription_id: "sub_4", billing_cancel_at_period_end: 0 }),
      license(5, { source: "stripe", stripe_subscription_id: "sub_5", billing_cancel_at_period_end: 0, plan_tier: "ouro", access_type: "annual_subscription" }),
      license(6, { source: "stripe", access_type: "paid_lifetime", billing_current_period_end: null, expires_at: "9999-12-31T00:00:00.000Z" }),
    ], prices, [
      { provider: "stripe", payment_type: "subscription", amount_cents: 3000, payment_count: 2 },
      { provider: "mercadopago", payment_type: "one_time", amount_cents: 1490, payment_count: 1 },
    ], new Set([4]), now);

    expect(result.summary).toMatchObject({
      activeAccess: 6,
      paidActive: 6,
      cardAutomatic: 3,
      cardEnding: 1,
      pixManual: 1,
      paidLifetime: 1,
      receivedCents: 4490,
      receivedCount: 3,
      nextCardCents: 21480,
      nextCardCount: 2,
      nextPixPotentialCents: 1490,
      nextPixPotentialCount: 1,
      pendingChangeRenewals: 1,
    });
  });

  it("does not project unknown prices or renewals outside 30 days", () => {
    const result = summarizeFinance([
      license(1, { plan_tier: "prata" }),
      license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0, expires_at: "2026-12-10T12:00:00.000Z", billing_current_period_end: "2026-12-10T12:00:00.000Z" }),
    ], prices, [], new Set(), now);
    expect(result.summary.unpricedRenewals).toBe(1);
    expect(result.summary.nextCardCents).toBe(0);
    expect(result.summary.nextPixPotentialCents).toBe(0);
  });
});
