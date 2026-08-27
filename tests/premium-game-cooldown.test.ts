import { describe, expect, test } from "vitest";
import {
  DEFAULT_PREMIUM_ACTIVATION_COOLDOWN_HOURS,
  planCooldownUntil,
  premiumGameCooldownMs,
} from "../src/lib/premium-games";
import { PLAN_RULES } from "../src/lib/plan-tiers";

describe("premium game cooldowns", () => {
  const activatedAt = "2026-08-27T12:00:00.000Z";

  test("keeps 24 hours for games without a custom cooldown", () => {
    expect(DEFAULT_PREMIUM_ACTIVATION_COOLDOWN_HOURS).toBe(24);
    expect(premiumGameCooldownMs(null)).toBe(24 * 60 * 60 * 1000);
    expect(planCooldownUntil(activatedAt, premiumGameCooldownMs(null)))
      .toBe("2026-08-28T12:00:00.000Z");
  });

  test("extends only the configured game's activation window", () => {
    const crimsonCooldownMs = premiumGameCooldownMs(72);
    expect(planCooldownUntil(activatedAt, crimsonCooldownMs))
      .toBe("2026-08-30T12:00:00.000Z");
  });

  test("preserves the 24-hour global cooldown for Bronze and Prata", () => {
    expect(PLAN_RULES.bronze.premiumCooldownScope).toBe("global");
    expect(PLAN_RULES.prata.premiumCooldownScope).toBe("global");
    expect(PLAN_RULES.ouro.premiumCooldownScope).toBe("game");

    expect(planCooldownUntil(activatedAt, PLAN_RULES.bronze.premiumCooldownMs))
      .toBe("2026-08-28T12:00:00.000Z");
    expect(planCooldownUntil(activatedAt, PLAN_RULES.prata.premiumCooldownMs))
      .toBe("2026-08-28T12:00:00.000Z");
    expect(PLAN_RULES.bronze.premiumLimitPerCycle).toBe(3);
  });
});
