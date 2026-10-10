import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { applyDuePixScheduledRenewals, extendPaidPixRenewal } from "../src/lib/mercadopago-pix";
import type { AppContext } from "../src/types";

const originalExpiry = "2030-01-15T12:00:00.000Z";
const extendedExpiry = "2030-02-15T12:00:00.000Z";

function setup(paymentStatus = "paid") {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY, expires_at TEXT, billing_current_period_start TEXT,
      billing_current_period_end TEXT, plan_tier TEXT, access_type TEXT,
      status TEXT, billing_status TEXT, billing_cancel_at_period_end INTEGER, updated_at TEXT
    );
    CREATE TABLE checkout_sessions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT, provider_session_id TEXT,
      provider_price_id TEXT, provider_payment_id TEXT, provider_external_reference TEXT,
      provider_qr_code TEXT, provider_qr_code_base64 TEXT, provider_ticket_url TEXT,
      provider_raw_status TEXT, provider_status_detail TEXT, provider_session_expires_at TEXT,
      provider_environment TEXT, plan_tier TEXT, plan_type TEXT, mode TEXT, status TEXT,
      payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      scheduled_renewal_license_id INTEGER, renewal_effective_at TEXT, renewal_applied_at TEXT,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_evidence_json TEXT,
      processed_at TEXT, updated_at TEXT
    );
  `);
  sqlite.prepare(`INSERT INTO licenses
    (id, expires_at, billing_current_period_end, plan_tier, access_type, status, billing_status)
    VALUES (7, ?, ?, 'ouro', 'monthly_subscription', 'active', 'active')`
  ).run(originalExpiry, originalExpiry);
  sqlite.prepare(`INSERT INTO checkout_sessions
    (id, provider, plan_tier, plan_type, payment_status, scheduled_renewal_license_id,
     renewal_effective_at, status, license_id)
    VALUES (8, 'mercadopago', 'prata', 'monthly', ?, 7, ?, 'completed', 7)`
  ).run(paymentStatus, originalExpiry);
  const merlin_db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args as []) }; },
        async run() {
          const result = sqlite.prepare(sql).run(...args as []);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  const c = { env: { merlin_db } } as unknown as AppContext;
  const checkout = {
    scheduled_renewal_license_id: 7, renewal_effective_at: originalExpiry,
    payment_status: paymentStatus, renewal_applied_at: null, plan_type: "monthly",
  } as Parameters<typeof extendPaidPixRenewal>[1];
  return { sqlite, c, checkout };
}

describe("paid Pix renewal entitlement", () => {
  test("credits a paid semiannual renewal immediately and applies its tier at the boundary", async () => {
    const { sqlite, c, checkout } = setup();
    sqlite.prepare("UPDATE checkout_sessions SET plan_type = 'semiannual' WHERE id = 8").run();
    checkout.plan_type = "semiannual";
    const paidAt = new Date("2030-01-10T10:00:00.000Z");
    expect(await extendPaidPixRenewal(c, checkout, paidAt)).toBe(true);
    expect(sqlite.prepare("SELECT expires_at, plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({
      expires_at: "2030-07-15T12:00:00.000Z", plan_tier: "ouro",
    });
    expect((await applyDuePixScheduledRenewals(c, new Date("2030-01-15T13:00:00.000Z"))).applied).toBe(1);
    expect(sqlite.prepare("SELECT access_type, plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({
      access_type: "semiannual_manual", plan_tier: "prata",
    });
    sqlite.close();
  });

  test("credits the next month immediately, without changing the current tier or adding it twice", async () => {
    const { sqlite, c, checkout } = setup();
    const paidAt = new Date("2030-01-10T10:00:00.000Z");
    expect(await extendPaidPixRenewal(c, checkout, paidAt)).toBe(true);
    expect(await extendPaidPixRenewal(c, checkout, paidAt)).toBe(true);
    expect(sqlite.prepare("SELECT expires_at, billing_current_period_end, plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({
      expires_at: extendedExpiry, billing_current_period_end: extendedExpiry, plan_tier: "ouro",
    });
    expect((await applyDuePixScheduledRenewals(c, paidAt)).applied).toBe(0);
    expect(sqlite.prepare("SELECT renewal_applied_at FROM checkout_sessions WHERE id = 8").get()).toMatchObject({ renewal_applied_at: null });
    sqlite.close();
  });

  test("applies the next tier at the old boundary without a gap or another month", async () => {
    const { sqlite, c } = setup();
    const before = new Date("2030-01-11T00:00:00.000Z");
    expect((await applyDuePixScheduledRenewals(c, before)).applied).toBe(0);
    expect(sqlite.prepare("SELECT expires_at FROM licenses WHERE id = 7").get()).toMatchObject({ expires_at: extendedExpiry });
    const after = new Date("2030-01-15T13:00:00.000Z");
    expect((await applyDuePixScheduledRenewals(c, after)).applied).toBe(1);
    expect((await applyDuePixScheduledRenewals(c, after)).applied).toBe(0);
    expect(sqlite.prepare("SELECT expires_at, plan_tier, billing_current_period_start FROM licenses WHERE id = 7").get()).toMatchObject({
      expires_at: extendedExpiry, plan_tier: "prata", billing_current_period_start: originalExpiry,
    });
    expect(sqlite.prepare("SELECT renewal_applied_at FROM checkout_sessions WHERE id = 8").get()).toMatchObject({
      renewal_applied_at: after.toISOString(),
    });
    sqlite.close();
  });

  test("never extends an unpaid Pix checkout", async () => {
    const { sqlite, c, checkout } = setup("awaiting_payment");
    expect(await extendPaidPixRenewal(c, checkout)).toBe(false);
    expect((await applyDuePixScheduledRenewals(c)).applied).toBe(0);
    expect(sqlite.prepare("SELECT expires_at FROM licenses WHERE id = 7").get()).toMatchObject({ expires_at: originalExpiry });
    sqlite.close();
  });

  test("does not shorten a license that was extended further before the tier switch", async () => {
    const { sqlite, c } = setup();
    await applyDuePixScheduledRenewals(c, new Date("2030-01-11T00:00:00.000Z"));
    const laterExpiry = "2030-03-15T12:00:00.000Z";
    sqlite.prepare("UPDATE licenses SET expires_at = ?, billing_current_period_end = ? WHERE id = 7")
      .run(laterExpiry, laterExpiry);
    expect((await applyDuePixScheduledRenewals(c, new Date("2030-01-15T13:00:00.000Z"))).applied).toBe(1);
    expect(sqlite.prepare("SELECT expires_at, billing_current_period_end FROM licenses WHERE id = 7").get()).toMatchObject({
      expires_at: laterExpiry, billing_current_period_end: laterExpiry,
    });
    sqlite.close();
  });
});
