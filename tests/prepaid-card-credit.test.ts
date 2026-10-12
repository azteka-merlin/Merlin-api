import { describe, expect, test } from "vitest";
import { initialPrepaidLayers, quotePrepaidCardChange, remainingCredit } from "../src/lib/prepaid-card-credit";
import type { PixTransitionEvidence } from "../src/lib/pix-plan-management";

const start = "2030-01-01T00:00:00.000Z";
const migrated = "2030-01-16T12:00:00.000Z";
const end = "2030-02-01T00:00:00.000Z";
const evidence = {
  operation: "pix_plan_transition", paymentMethod: "card", currentTier: "bronze", currentPeriod: "monthly",
  currentPeriodStart: start, currentPeriodEnd: end, targetTier: "bronze", targetPeriod: "monthly",
  currentPeriodPriceCents: 1490, targetFullPriceCents: 1490, amountCents: 0,
  timing: "payment_method_only", nextRenewalAt: end, checkoutCollectionMode: "subscription",
  unusedPixCreditCents: 745,
} as PixTransitionEvidence;

describe("credit after Pix-to-card migration without an initial charge", () => {
  test("the next tier change buys its first full card month minus unused paid Pix", () => {
    const layers = initialPrepaidLayers(evidence, migrated);
    expect(layers).toHaveLength(1);
    expect(remainingCredit(layers, migrated)).toBe(745);
    const quote = quotePrepaidCardChange({
      now: migrated, currentTier: "bronze", currentPeriod: "monthly", currentPriceCents: 1490,
      targetTier: "ouro", targetPeriod: "monthly", targetPriceCents: 2490,
      currentRenewalAt: end, currentPeriodStart: start, layers,
    });
    expect(quote).toMatchObject({ timing: "immediate", amountDueNowCents: 1745,
      unusedCreditCents: 745, nextRenewalAt: "2030-02-16T12:00:00.000Z",
      targetPeriodStart: migrated });
    expect(quote.layersAfterPayment).toEqual([{
      amountCents: 2490, startsAt: migrated, endsAt: quote.nextRenewalAt,
    }]);
  });

  test("a tier and period change uses the same one-time Pix credit", () => {
    const quote = quotePrepaidCardChange({
      now: migrated, currentTier: "bronze", currentPeriod: "monthly", currentPriceCents: 1490,
      targetTier: "prata", targetPeriod: "annual", targetPriceCents: 19990,
      currentRenewalAt: end, currentPeriodStart: start,
      layers: initialPrepaidLayers(evidence, migrated),
    });
    expect(quote).toMatchObject({ amountDueNowCents: 19245,
      nextRenewalAt: "2031-01-16T12:00:00.000Z" });
  });

  test("the first card invoice is not anchored to the old Pix due date even near expiry", () => {
    const now = "2030-01-31T23:45:00.000Z";
    const quote = quotePrepaidCardChange({
      now, currentTier: "bronze", currentPeriod: "monthly", currentPriceCents: 1490,
      targetTier: "ouro", targetPeriod: "monthly", targetPriceCents: 2490,
      currentRenewalAt: end, currentPeriodStart: start,
      layers: initialPrepaidLayers(evidence, migrated),
    });
    expect(quote.timing).toBe("immediate");
    expect(quote.amountDueNowCents).toBe(2489);
    expect(quote.nextRenewalAt).toBe("2030-02-28T23:45:00.000Z");
  });

  test("legacy prepaid adjustments still count as paid credit once", () => {
    const legacy = { ...evidence, targetTier: "prata", targetFullPriceCents: 1990,
      timing: "immediate", amountCents: 250 } as PixTransitionEvidence;
    const layers = initialPrepaidLayers(legacy, migrated);
    expect(layers).toHaveLength(2);
    expect(remainingCredit(layers, migrated)).toBe(995);
    const quote = quotePrepaidCardChange({
      now: migrated, currentTier: "prata", currentPeriod: "monthly", currentPriceCents: 1990,
      targetTier: "ouro", targetPeriod: "annual", targetPriceCents: 24990,
      currentRenewalAt: end, currentPeriodStart: start, layers,
    });
    expect(quote.amountDueNowCents).toBe(23995);
  });

  test("a downgrade cannot consume the paid period early", () => {
    expect(() => quotePrepaidCardChange({
      now: migrated, currentTier: "bronze", currentPeriod: "monthly", currentPriceCents: 1490,
      targetTier: "bronze", targetPeriod: "monthly", targetPriceCents: 1490,
      currentRenewalAt: end, currentPeriodStart: start,
      layers: initialPrepaidLayers(evidence, migrated),
    })).toThrow("Reducao de plano");
  });
});
