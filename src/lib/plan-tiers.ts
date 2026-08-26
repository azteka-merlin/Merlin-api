import type { AppContext } from "../types";

export const PLAN_TIERS = ["bronze", "prata", "ouro"] as const;
export type PlanTier = typeof PLAN_TIERS[number];

export type LicensePlanFields = {
  license_type?: string | null;
  plan_tier?: string | null;
  created_at?: string | null;
  billing_current_period_start?: string | null;
  billing_current_period_end?: string | null;
  premium_catalog_restricted?: number | null;
};

export type PlanSettings = {
  plansEnabled: boolean;
};

export type EffectivePlan = {
  plansEnabled: boolean;
  storedTier: PlanTier | null;
  effectiveTier: PlanTier;
};

export const PLAN_RULES: Record<PlanTier, {
  label: string;
  rank: number;
  premiumCooldownScope: "global" | "game";
  premiumCooldownMs: number;
  premiumLimitPerCycle: number | null;
  premiumReleaseDelayMs: number;
}> = {
  bronze: {
    label: "Bronze",
    rank: 1,
    premiumCooldownScope: "global",
    premiumCooldownMs: 24 * 60 * 60 * 1000,
    premiumLimitPerCycle: 3,
    premiumReleaseDelayMs: 7 * 24 * 60 * 60 * 1000,
  },
  prata: {
    label: "Prata",
    rank: 2,
    premiumCooldownScope: "global",
    premiumCooldownMs: 24 * 60 * 60 * 1000,
    premiumLimitPerCycle: null,
    premiumReleaseDelayMs: 5 * 24 * 60 * 60 * 1000,
  },
  ouro: {
    label: "Ouro",
    rank: 3,
    premiumCooldownScope: "game",
    premiumCooldownMs: 24 * 60 * 60 * 1000,
    premiumLimitPerCycle: null,
    premiumReleaseDelayMs: 48 * 60 * 60 * 1000,
  },
};

export function normalizePlanTier(value: unknown): PlanTier | null {
  const normalized = String(value || "").trim().toLowerCase();
  return PLAN_TIERS.includes(normalized as PlanTier) ? normalized as PlanTier : null;
}

export function normalizeStoredPlanTier(value: unknown, fallback: PlanTier = "ouro"): PlanTier {
  return normalizePlanTier(value) || fallback;
}

export function planTierLabel(value: PlanTier | null | undefined) {
  return value ? PLAN_RULES[value].label : null;
}

export async function getPlanSettings(c: AppContext): Promise<PlanSettings> {
  const row = await c.env.merlin_db
    .prepare("SELECT COALESCE(plans_enabled, 0) AS plans_enabled FROM billing_settings WHERE id = 1")
    .first<{ plans_enabled: number }>();

  return {
    plansEnabled: row?.plans_enabled === 1,
  };
}

export function resolveEffectivePlan(settings: PlanSettings, license: LicensePlanFields): EffectivePlan {
  const isTest = (license.license_type || "normal") === "test";
  const storedTier = isTest ? null : normalizeStoredPlanTier(license.plan_tier, "ouro");

  return {
    plansEnabled: settings.plansEnabled,
    storedTier,
    effectiveTier: settings.plansEnabled ? storedTier || "ouro" : "ouro",
  };
}

export function addMonthsUtc(date: Date, months: number) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

export function resolveCurrentMonthlyCycle(license: LicensePlanFields, now = new Date()) {
  const anchorInput = license.billing_current_period_start || license.created_at || now.toISOString();
  const anchor = new Date(anchorInput);
  const cycleStart = Number.isNaN(anchor.getTime()) ? new Date(now) : anchor;

  while (addMonthsUtc(cycleStart, 1).getTime() <= now.getTime()) {
    const next = addMonthsUtc(cycleStart, 1);
    cycleStart.setTime(next.getTime());
  }

  return {
    cycleStart: cycleStart.toISOString(),
    cycleEnd: addMonthsUtc(cycleStart, 1).toISOString(),
  };
}

export function premiumReleaseAt(createdAt: string, tier: PlanTier) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return null;
  }
  return new Date(created.getTime() + PLAN_RULES[tier].premiumReleaseDelayMs).toISOString();
}
