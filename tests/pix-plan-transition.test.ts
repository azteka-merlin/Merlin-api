import { describe, expect, test } from "vitest";
import { quotePixTransition } from "../src/lib/pix-plan-transition";

const base = {
  currentTier: "bronze" as const,
  currentPeriod: "monthly" as const,
  currentPeriodPriceCents: 1490,
  currentPeriodStart: "2030-01-01T00:00:00.000Z",
  currentPeriodEnd: "2030-02-01T00:00:00.000Z",
  targetPaymentMethod: "pix" as const,
  now: "2030-01-16T12:00:00.000Z",
};

describe("Pix plan transition quote", () => {
  test.each([
    { name: "tier Pix", targetTier: "prata" as const, targetPeriod: "monthly" as const, targetPaymentMethod: "pix" as const,
      targetPriceCents: 1990, timing: "immediate", due: 250, renewal: base.currentPeriodEnd },
    { name: "tier + cartao", targetTier: "prata" as const, targetPeriod: "monthly" as const, targetPaymentMethod: "card" as const,
      targetPriceCents: 1990, timing: "immediate", due: 1245, renewal: "2030-02-16T12:00:00.000Z" },
    { name: "periodo Pix", targetTier: "bronze" as const, targetPeriod: "semiannual" as const, targetPaymentMethod: "pix" as const,
      targetPriceCents: 6590, timing: "immediate", due: 5845, renewal: "2030-07-16T12:00:00.000Z" },
    { name: "periodo + cartao", targetTier: "bronze" as const, targetPeriod: "semiannual" as const, targetPaymentMethod: "card" as const,
      targetPriceCents: 7190, timing: "immediate", due: 6445, renewal: "2030-07-16T12:00:00.000Z" },
    { name: "tier + periodo Pix", targetTier: "prata" as const, targetPeriod: "annual" as const, targetPaymentMethod: "pix" as const,
      targetPriceCents: 13_900, timing: "immediate", due: 13_155, renewal: "2031-01-16T12:00:00.000Z" },
    { name: "tier + periodo + cartao", targetTier: "prata" as const, targetPeriod: "annual" as const, targetPaymentMethod: "card" as const,
      targetPriceCents: 14_900, timing: "immediate", due: 14_155, renewal: "2031-01-16T12:00:00.000Z" },
    { name: "somente metodo", targetTier: "bronze" as const, targetPeriod: "monthly" as const, targetPaymentMethod: "card" as const,
      targetPriceCents: 1490, timing: "payment_method_only", due: 0, renewal: base.currentPeriodEnd },
  ])("$name: valor devido e proximo vencimento", (scenario) => {
    const quote = quotePixTransition({ ...base, targetTier: scenario.targetTier,
      targetPeriod: scenario.targetPeriod, targetPaymentMethod: scenario.targetPaymentMethod,
      targetPriceCents: scenario.targetPriceCents });
    expect(quote).toMatchObject({ timing: scenario.timing,
      amountDueNowCents: scenario.due, nextRenewalAt: scenario.renewal });
  });

  test("Pix unchanged is not a billable operation", () => {
    expect(() => quotePixTransition({ ...base, targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490 }))
      .toThrow("No plan change requested");
  });

  test("a shorter period is deferred even with a tier upgrade", () => {
    expect(() => quotePixTransition({ ...base, currentPeriod: "semiannual", currentPeriodEnd: "2030-07-01T00:00:00.000Z",
      targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 })).toThrow(/Downgrade/);
    const quote = quotePixTransition({ ...base, now: "2030-06-28T00:00:00.000Z", currentPeriod: "semiannual",
      currentPeriodEnd: "2030-07-01T00:00:00.000Z", targetTier: "prata", targetPeriod: "monthly",
      targetPriceCents: 1990, targetPaymentMethod: "card" });
    expect(quote).toMatchObject({ timing: "period_end", amountDueNowCents: 0,
      nextRenewalAt: "2030-07-01T00:00:00.000Z" });
  });

  test("uses the amount actually paid in Pix, not a new catalogue price", () => {
    const quote = quotePixTransition({ ...base, currentPeriodPriceCents: 1190,
      targetTier: "prata", targetPeriod: "annual", targetPriceCents: 13_900 });
    expect(quote.unusedPixCreditCents).toBe(595);
    expect(quote.amountDueNowCents).toBe(13_305);
  });

  test("reactivates expired Pix with the full target price and a fresh term", () => {
    expect(quotePixTransition({ ...base, now: base.currentPeriodEnd,
      targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 }))
      .toMatchObject({ timing: "reactivation", amountDueNowCents: 1990, unusedPixCreditCents: 0,
        effectiveAt: base.currentPeriodEnd, nextRenewalAt: "2030-03-01T00:00:00.000Z" });
    expect(quotePixTransition({ ...base, now: base.currentPeriodEnd, targetPaymentMethod: "card",
      targetTier: "ouro", targetPeriod: "annual", targetPriceCents: 18_900 }))
      .toMatchObject({ timing: "reactivation", amountDueNowCents: 18_900,
        nextRenewalAt: "2031-02-01T00:00:00.000Z" });
  });

  test("the quote never creates a second charge at the old Pix due date", () => {
    const now = "2030-01-31T23:30:00.000Z";
    expect(quotePixTransition({ ...base, now, targetPaymentMethod: "card",
      targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490 }))
      .toMatchObject({ timing: "payment_method_only", amountDueNowCents: 0,
        nextRenewalAt: base.currentPeriodEnd });
    expect(quotePixTransition({ ...base, now, targetPaymentMethod: "card",
      targetTier: "prata", targetPeriod: "semiannual", targetPriceCents: 9590 }))
      .toMatchObject({ timing: "immediate", amountDueNowCents: 9589,
        nextRenewalAt: "2030-07-31T23:30:00.000Z" });
  });

  test("a paid card upgrade always buys its first full cycle minus remaining Pix credit", () => {
    expect(quotePixTransition({ ...base, now: "2030-01-31T23:29:59.999Z", targetPaymentMethod: "card",
      targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 }))
      .toMatchObject({ timing: "immediate", amountDueNowCents: 1989,
        nextRenewalAt: "2030-02-28T23:29:59.999Z" });
  });

  test("a small proportional tier difference does not waive a full first invoice", () => {
    const quote = quotePixTransition({ ...base, now: "2030-01-29T00:00:00.000Z",
      targetPaymentMethod: "card", targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 });
    expect(quote).toMatchObject({ timing: "immediate", amountDueNowCents: 1846,
      nextRenewalAt: "2030-02-28T00:00:00.000Z" });
    expect(quotePixTransition({ ...base, now: "2030-01-20T00:00:00.000Z",
      targetPaymentMethod: "card", targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 })
      .amountDueNowCents).toBeGreaterThanOrEqual(100);
  });
  test("charges only the proportional tier difference and preserves expiry", () => {
    expect(quotePixTransition({ ...base, targetTier: "prata", targetPeriod: "monthly", targetPriceCents: 1990 }))
      .toMatchObject({ timing: "immediate", amountDueNowCents: 250, nextRenewalAt: base.currentPeriodEnd });
  });

  test("starts an annual prepaid period now and credits unused monthly Pix", () => {
    const quote = quotePixTransition({ ...base, targetTier: "bronze", targetPeriod: "annual", targetPriceCents: 10_900 });
    expect(quote).toMatchObject({ timing: "immediate", unusedPixCreditCents: 745, amountDueNowCents: 10_155,
      nextRenewalAt: "2031-01-16T12:00:00.000Z" });
  });

  test("moves to card without charging the already-paid period", () => {
    expect(quotePixTransition({ ...base, targetPaymentMethod: "card", targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490 }))
      .toMatchObject({ timing: "payment_method_only", amountDueNowCents: 0, nextRenewalAt: base.currentPeriodEnd });
  });

  test("blocks downgrades until the final seven days", () => {
    expect(() => quotePixTransition({ ...base, currentTier: "ouro", currentPeriodPriceCents: 2490,
      targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490 })).toThrow(/Downgrade/);
    expect(quotePixTransition({ ...base, now: "2030-01-28T00:00:00.000Z", currentTier: "ouro", currentPeriodPriceCents: 2490,
      targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490 })).toMatchObject({ timing: "period_end", amountDueNowCents: 1490 });
    expect(quotePixTransition({ ...base, now: "2030-01-28T00:00:00.000Z", currentTier: "ouro", currentPeriodPriceCents: 2490,
      targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490, targetPaymentMethod: "card" }))
      .toMatchObject({ timing: "period_end", amountDueNowCents: 0, nextRenewalAt: base.currentPeriodEnd });
  });
});
