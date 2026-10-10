import { describe, expect, test } from "vitest";
import { addBillingPeriod, billingPeriodMonths } from "../src/lib/billing-period";
import { assertBillingPlanPrice, type BillingPriceSnapshot } from "../src/lib/billing-settings";

function stripePrice(interval: string | null, count: number | null): BillingPriceSnapshot {
  return {
    provider: "stripe", priceId: "price_stage", productName: "Merlin", amountCents: 9990,
    currency: "brl", recurringInterval: interval, recurringIntervalCount: count,
    active: true, syncedAt: new Date().toISOString(), stale: false,
  };
}

describe("six-month billing period", () => {
  test("advances Pix entitlement by six calendar months without overflowing month-end", () => {
    expect(billingPeriodMonths("semiannual")).toBe(6);
    expect(addBillingPeriod("2030-08-31T12:00:00.000Z", "semiannual"))
      .toBe("2031-02-28T12:00:00.000Z");
    expect(addBillingPeriod("2027-08-31T12:00:00.000Z", "semiannual"))
      .toBe("2028-02-29T12:00:00.000Z");
  });

  test("never confuses a six-month Stripe Price with a monthly Price", () => {
    const sixMonths = stripePrice("month", 6);
    expect(() => assertBillingPlanPrice("semiannual", sixMonths)).not.toThrow();
    expect(() => assertBillingPlanPrice("monthly", sixMonths)).toThrow();
    expect(() => assertBillingPlanPrice("semiannual", stripePrice("month", 1))).toThrow();
    expect(() => assertBillingPlanPrice("semiannual", stripePrice("year", 1))).toThrow();
  });
});
