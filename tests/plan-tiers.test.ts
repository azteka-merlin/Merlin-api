import { describe, expect, test } from "vitest";
import { PLAN_RULES, premiumReleaseAt, resolveCurrentMonthlyCycle, resolveEffectivePlan } from "../src/lib/plan-tiers";

describe("plan tiers", () => {
  test("keeps stored tiers but applies Ouro while the feature flag is disabled", () => {
    expect(resolveEffectivePlan({ plansEnabled: false }, { plan_tier: "bronze", license_type: "normal" }))
      .toEqual({ plansEnabled: false, storedTier: "bronze", effectiveTier: "ouro" });
    expect(resolveEffectivePlan({ plansEnabled: true }, { plan_tier: "bronze", license_type: "normal" }).effectiveTier)
      .toBe("bronze");
  });

  test("does not assign a stored tier to test licenses", () => {
    expect(resolveEffectivePlan({ plansEnabled: true }, { plan_tier: "bronze", license_type: "test" }))
      .toEqual({ plansEnabled: true, storedTier: null, effectiveTier: "ouro" });
  });

  test("uses monthly cycles even for an annual subscription anchor", () => {
    const cycle = resolveCurrentMonthlyCycle(
      { billing_current_period_start: "2026-01-31T12:00:00.000Z" },
      new Date("2026-03-15T12:00:00.000Z"),
    );
    expect(cycle).toEqual({ cycleStart: "2026-02-28T12:00:00.000Z", cycleEnd: "2026-03-28T12:00:00.000Z" });
  });

  test("keeps the published Premium limits and release delays", () => {
    expect(PLAN_RULES.bronze.premiumLimitPerCycle).toBe(3);
    expect(PLAN_RULES.prata.premiumCooldownScope).toBe("global");
    expect(PLAN_RULES.ouro.premiumCooldownScope).toBe("game");
    expect(premiumReleaseAt("2026-01-01T00:00:00.000Z", "ouro")).toBe("2026-01-03T00:00:00.000Z");
  });
});
