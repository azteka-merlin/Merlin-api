import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { getPublicPixOrderStatus } from "../src/lib/mercadopago-pix";
import { PIX_PLAN_TRANSITION_OPERATION } from "../src/lib/pix-plan-management";
import { addBillingPeriod } from "../src/lib/billing-period";

afterEach(() => vi.unstubAllGlobals());

test.each([
  { name: "tier upgrade", tier: "prata", period: "monthly" as const, amountCents: 250, targetFullPriceCents: 1990 },
  { name: "period upgrade", tier: "bronze", period: "semiannual" as const, amountCents: 5845, targetFullPriceCents: 6590 },
  { name: "tier and period upgrade", tier: "prata", period: "annual" as const, amountCents: 13_155, targetFullPriceCents: 13_900 },
])("confirmed Pix $name updates the same license without replacing key or HWID", async (scenario) => {
  const sqlite = new DatabaseSync(":memory:");
  const externalReference = `mpix_${crypto.randomUUID()}`;
  const start = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 15 * 86_400_000).toISOString();
  sqlite.exec(`
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY, license_key TEXT, name TEXT, contact TEXT, hwid TEXT,
      status TEXT, source TEXT, plan_tier TEXT, access_type TEXT, expires_at TEXT,
      billing_current_period_start TEXT, billing_current_period_end TEXT,
      billing_cancel_at_period_end INTEGER, billing_status TEXT,
      stripe_subscription_id TEXT, stripe_customer_id TEXT, updated_at TEXT
    );
    CREATE TABLE checkout_sessions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT, provider_session_id TEXT,
      provider_price_id TEXT, provider_payment_id TEXT, provider_external_reference TEXT,
      provider_qr_code TEXT, provider_qr_code_base64 TEXT, provider_ticket_url TEXT,
      provider_raw_status TEXT, provider_status_detail TEXT, provider_session_expires_at TEXT,
      provider_environment TEXT, plan_tier TEXT, plan_type TEXT, mode TEXT, status TEXT,
      payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      scheduled_renewal_license_id INTEGER, renewal_effective_at TEXT, renewal_applied_at TEXT,
      operation_type TEXT, upgrade_license_id INTEGER, upgrade_processed_at TEXT,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_evidence_json TEXT,
      processed_at TEXT, completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY, customer_id INTEGER, license_id INTEGER, provider TEXT,
      provider_payment_id TEXT UNIQUE, provider_checkout_session_id TEXT,
      provider_subscription_id TEXT, amount_cents INTEGER, currency TEXT,
      status TEXT, payment_type TEXT, billing_reason TEXT, created_at TEXT
    );
  `);
  sqlite.prepare(`INSERT INTO licenses (id, license_key, name, contact, hwid, status, source,
    plan_tier, access_type, expires_at, billing_current_period_start, billing_current_period_end, billing_status)
    VALUES (7, 'MERLIN-EXISTING', 'Customer', 'someone@example.com', 'existing-hwid',
      'active', 'mercadopago_pix', 'bronze', 'monthly_subscription', ?, ?, ?, 'active')`)
    .run(end, start, end);
  const evidence = { amountCents: scenario.amountCents, currency: "brl", currentTier: "bronze", currentPeriod: "monthly",
    currentPeriodStart: start, currentPeriodEnd: end, targetFullPriceCents: scenario.targetFullPriceCents, timing: "immediate" };
  sqlite.prepare(`INSERT INTO checkout_sessions (id, customer_id, provider, provider_session_id,
    provider_price_id, provider_external_reference, provider_session_expires_at,
    provider_environment, plan_tier, plan_type, mode, status, payment_status,
    operation_type, upgrade_license_id, checkout_evidence_json)
    VALUES (8, 3, 'mercadopago', 'ORDTEST', ?, ?, ?,
      'test', ?, ?, 'subscription', 'open', 'awaiting_payment', ?, 7, ?)`)
    .run(`pix:change:${scenario.tier}:${scenario.period}`, externalReference, new Date(Date.now() + 30 * 60_000).toISOString(),
      scenario.tier, scenario.period,
      PIX_PLAN_TRANSITION_OPERATION, JSON.stringify(evidence));
  const merlin_db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return sqlite.prepare(sql).get(...args as []) as T | null; },
        async run() {
          const result = sqlite.prepare(sql).run(...args as []);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  const c = { env: { merlin_db, ENVIRONMENT: "staging", PIX_ENABLED: "true", PIX_PROVIDER: "mercadopago",
    PIX_ENV: "test", MERCADO_PAGO_TEST_ACCESS_TOKEN: "fake", MERCADO_PAGO_API_BASE: "https://mp.example" } } as unknown as AppContext;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "ORDTEST", external_reference: externalReference, status: "processed", status_detail: "accredited",
    total_amount: (scenario.amountCents / 100).toFixed(2), total_paid_amount: (scenario.amountCents / 100).toFixed(2), currency: "BRL",
    transactions: { payments: [{ id: "PAYTEST", payment_method: { id: "pix" } }] },
  }), { status: 200 })));

  const result = await getPublicPixOrderStatus(c, externalReference);
  expect(result.status).toBe("paid");
  const completedAt = sqlite.prepare("SELECT completed_at FROM checkout_sessions WHERE id = 8").get() as { completed_at: string };
  const expectedExpiry = scenario.period === "monthly" ? end : addBillingPeriod(completedAt.completed_at, scenario.period);
  expect(sqlite.prepare("SELECT license_key, hwid, plan_tier, expires_at FROM licenses WHERE id = 7").get())
    .toMatchObject({ license_key: "MERLIN-EXISTING", hwid: "existing-hwid", plan_tier: scenario.tier, expires_at: expectedExpiry });
  expect(sqlite.prepare("SELECT amount_cents, status FROM payments WHERE provider_payment_id = 'PAYTEST'").get())
    .toMatchObject({ amount_cents: scenario.amountCents, status: "paid" });
  expect(sqlite.prepare("SELECT license_id, upgrade_processed_at FROM checkout_sessions WHERE id = 8").get())
    .toMatchObject({ license_id: 7, upgrade_processed_at: expect.any(String) });
  sqlite.exec("UPDATE checkout_sessions SET license_id = NULL, upgrade_processed_at = NULL, processed_at = NULL WHERE id = 8");
  const retried = await getPublicPixOrderStatus(c, externalReference);
  expect(retried.status).toBe("paid");
  expect(sqlite.prepare("SELECT license_id, upgrade_processed_at FROM checkout_sessions WHERE id = 8").get())
    .toMatchObject({ license_id: 7, upgrade_processed_at: expect.any(String) });
  expect(sqlite.prepare("SELECT count(*) AS count FROM payments WHERE provider_payment_id = 'PAYTEST'").get())
    .toMatchObject({ count: 1 });
  sqlite.close();
});
