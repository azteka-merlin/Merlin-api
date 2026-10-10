import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { getBillingSettings, updateBillingSettings } from "../src/lib/billing-settings";
import type { AppContext } from "../src/types";

describe("semiannual billing settings", () => {
  test("are opt-in and persist without changing existing period settings", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE billing_settings (
        id INTEGER PRIMARY KEY, billing_enabled INTEGER, public_signup_enabled INTEGER,
        plans_enabled INTEGER, monthly_enabled INTEGER, semiannual_enabled INTEGER DEFAULT 0,
        annual_enabled INTEGER, lifetime_enabled INTEGER, pix_enabled INTEGER,
        pix_monthly_enabled INTEGER, pix_semiannual_enabled INTEGER DEFAULT 0,
        pix_annual_enabled INTEGER, pix_lifetime_enabled INTEGER,
        monthly_card_trial_enabled INTEGER, monthly_card_trial_days INTEGER,
        staging_email_delivery_enabled INTEGER, premium_catalog_cutoff_at TEXT,
        monthly_price_id TEXT, annual_price_id TEXT, lifetime_price_id TEXT,
        pix_annual_price_id TEXT, pix_lifetime_price_id TEXT, currency TEXT,
        free_access_type TEXT, free_duration_days INTEGER, updated_at TEXT
      );
    `);
    const merlin_db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() { return sqlite.prepare(sql).get(...args as []) || null; },
          async run() { sqlite.prepare(sql).run(...args as []); return { success: true }; },
        };
      },
    };
    const c = { env: { merlin_db, ENVIRONMENT: "staging" } } as unknown as AppContext;
    const initial = await getBillingSettings(c);
    expect(initial.semiannualEnabled).toBe(false);
    expect(initial.pixSemiannualEnabled).toBe(false);
    const updated = await updateBillingSettings(c, {
      publicSignupEnabled: true, billingEnabled: true, plansEnabled: true,
      monthlyEnabled: true, semiannualEnabled: true, annualEnabled: true,
      lifetimeEnabled: false, pixEnabled: true, pixMonthlyEnabled: true,
      pixSemiannualEnabled: true, pixAnnualEnabled: true,
    });
    expect(updated.semiannualEnabled).toBe(true);
    expect(updated.pixSemiannualEnabled).toBe(true);
    expect(updated.monthlyEnabled).toBe(true);
    expect(updated.annualEnabled).toBe(true);
    sqlite.close();
  });
});
