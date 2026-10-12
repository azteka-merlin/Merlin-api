import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";

vi.mock("../src/lib/billing-settings", () => ({
  getBillingSettings: async () => ({ billingEnabled: true, publicSignupEnabled: true,
    plansEnabled: true, monthlyEnabled: true, monthlyCardTrialEnabled: false }),
  getStripePriceSnapshot: async () => ({ amountCents: 1490, currency: "brl" }),
  assertBillingPlanPrice: () => undefined,
}));
vi.mock("../src/lib/subscription-plan-change", () => ({
  getCardPlanPrice: async () => ({ provider_price_id: "price_bronze_monthly" }),
}));
vi.mock("../src/lib/admin-license-service", () => ({
  findLicenseByEmailContact: async () => null,
  normalizeContact: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("../src/lib/email-verification", () => ({
  assertRecentPublicEmailVerification: async () => null,
  consumePublicEmailVerification: async () => undefined,
}));
vi.mock("../src/lib/recovery-pin", () => ({
  RECOVERY_SECRET_DESCRIPTION: "PIN required",
  hashRecoveryPin: async () => "pin-hash",
  normalizeRecoveryPin: (value: string) => value,
}));

import { createPublicStripeCheckout } from "../src/lib/public-checkout";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, email_normalized TEXT,
      email_verified_at TEXT, stripe_customer_id TEXT, updated_at TEXT);
    CREATE TABLE checkout_sessions (id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT,
      provider_session_id TEXT, provider_session_url TEXT, provider_session_expires_at TEXT,
      provider_price_id TEXT, plan_tier TEXT, plan_type TEXT, mode TEXT, status TEXT,
      payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      scheduled_renewal_license_id INTEGER, upgrade_license_id INTEGER,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_ip TEXT, checkout_user_agent TEXT,
      checkout_country TEXT, checkout_evidence_json TEXT, idempotency_key TEXT UNIQUE,
      created_at TEXT, updated_at TEXT);
    INSERT INTO customers (id, email, email_normalized, email_verified_at, stripe_customer_id)
      VALUES (3, 'someone@example.com', 'someone@example.com', '2026-01-01', 'cus_test');
  `);
  sqlite.exec(readFileSync(new URL("../migrations/0081_new_customer_checkout_exclusion.sql", import.meta.url), "utf8"));
  const merlin_db = { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() { return sqlite.prepare(sql).get(...args as []) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...args as []) as T[] }; },
      async run() { const result = sqlite.prepare(sql).run(...args as []);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
  } };
  const c = { env: { merlin_db, STRIPE_SECRET_KEY: "sk_test_fake", PUBLIC_APP_ORIGIN: "https://example.com" },
    req: { header: () => null } } as unknown as AppContext;
  const fetchMock = vi.fn(async () => {
    const reservation = sqlite.prepare("SELECT provider_session_id FROM checkout_sessions WHERE customer_id = 3").get() as
      { provider_session_id: string } | undefined;
    expect(reservation?.provider_session_id).toMatch(/^pending_checkout_/);
    return new Response(JSON.stringify({ object: "checkout.session",
      id: "cs_first", url: "https://checkout.stripe.test/first", status: "open",
      expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const input = { name: "Customer", contact: "someone@example.com", recoveryPin: "12345",
    acceptedRecoveryNotice: true, planType: "monthly" as const, planTier: "bronze" as const };
  return { sqlite, c, input, fetchMock };
}

describe("public Checkout reservation", () => {
  test("reserves before calling Stripe and blocks a second payment session", async () => {
    const { sqlite, c, input, fetchMock } = setup();
    const first = await createPublicStripeCheckout(c, input);
    expect(first.checkoutSessionId).toBe("cs_first");
    await expect(createPublicStripeCheckout(c, { ...input, planTier: "prata" }))
      .rejects.toThrow(/checkout aberto|cobranca em andamento/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT provider_session_id FROM checkout_sessions").get())
      .toMatchObject({ provider_session_id: "cs_first" });
    sqlite.close();
  });

  test("Stripe and Pix cannot reserve a first purchase concurrently", async () => {
    const { sqlite, c, input } = setup();
    await createPublicStripeCheckout(c, input);
    expect(() => sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status) VALUES (3, 'mercadopago', 'mp_first', 'open', 'awaiting_payment')`).run())
      .toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  test("two concurrent requests produce at most one payable Stripe session", async () => {
    const { sqlite, c, input, fetchMock } = setup();
    const attempts = await Promise.allSettled([
      createPublicStripeCheckout(c, input), createPublicStripeCheckout(c, input),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM checkout_sessions").get())
      .toMatchObject({ count: 1 });
    sqlite.close();
  });
});
