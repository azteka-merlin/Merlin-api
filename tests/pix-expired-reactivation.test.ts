import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { getPublicPixOrderStatus } from "../src/lib/mercadopago-pix";
import { addBillingPeriod } from "../src/lib/billing-period";

afterEach(() => vi.unstubAllGlobals());

test("paid Pix reactivates the expired license on a different tier and period only once", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const reference = `mpix_${crypto.randomUUID()}`;
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, email_normalized TEXT, email_verified_at TEXT);
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY, license_key TEXT, name TEXT, contact TEXT, contact_type TEXT,
      recovery_pin_hash TEXT, recovery_notice_accepted_at TEXT, hwid TEXT,
      expires_at TEXT, status TEXT, revoked_reason TEXT, revoked_origin TEXT, revoked_event_id TEXT,
      source TEXT, plan_tier TEXT, premium_catalog_restricted INTEGER, customer_id INTEGER,
      access_type TEXT, billing_status TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT, billing_current_period_start TEXT, billing_current_period_end TEXT,
      billing_cancel_at_period_end INTEGER, updated_at TEXT
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
    INSERT INTO customers (id, email, email_normalized) VALUES (3, 'someone@example.com', 'someone@example.com');
    INSERT INTO licenses (id, license_key, name, contact, hwid, expires_at, status, source,
      plan_tier, customer_id, access_type, billing_status)
      VALUES (7, 'MERLIN-EXISTING', 'Customer', 'someone@example.com', 'old-hwid',
        '2030-01-01T00:00:00.000Z', 'expired', 'mercadopago_pix',
        'bronze', 3, 'monthly_subscription', 'active');
  `);
  sqlite.prepare(`INSERT INTO checkout_sessions (id, customer_id, provider, provider_session_id,
    provider_price_id, provider_external_reference, provider_session_expires_at,
    provider_environment, plan_tier, plan_type, mode, status, payment_status,
    reactivation_license_id, pending_name, pending_recovery_pin_hash,
    pending_recovery_notice_accepted_at, checkout_evidence_json)
    VALUES (8, 3, 'mercadopago', 'ORDTEST', 'pix:prata:semiannual', ?, ?,
      'test', 'prata', 'semiannual', 'subscription', 'open', 'awaiting_payment',
      7, 'Customer', 'existing-pin-hash', '2030-01-01T00:00:00.000Z', ?)`)
    .run(reference, new Date(Date.now() + 30 * 60_000).toISOString(),
      JSON.stringify({ amountCents: 8390, currency: "brl" }));
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
    PIX_ENV: "test", MERCADO_PAGO_TEST_ACCESS_TOKEN: "fake", MERCADO_PAGO_API_BASE: "https://mp.example" },
    executionCtx: { waitUntil() {} } } as unknown as AppContext;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "ORDTEST", external_reference: reference, status: "processed", status_detail: "accredited",
    total_amount: "83.90", total_paid_amount: "83.90", currency: "BRL",
    transactions: { payments: [{ id: "PAYTEST", payment_method: { id: "pix" } }] },
  }), { status: 200 })));

  expect((await getPublicPixOrderStatus(c, reference)).status).toBe("paid");
  const completed = sqlite.prepare("SELECT completed_at FROM checkout_sessions WHERE id = 8").get() as { completed_at: string };
  const updated = sqlite.prepare("SELECT id, license_key, plan_tier, access_type, expires_at, status FROM licenses WHERE id = 7")
    .get() as { id: number; license_key: string; plan_tier: string; access_type: string; expires_at: string; status: string };
  expect(updated)
    .toMatchObject({ id: 7, license_key: "MERLIN-EXISTING", plan_tier: "prata",
      access_type: "semiannual_manual", status: "active" });
  expect(Math.abs(Date.parse(updated.expires_at) - Date.parse(addBillingPeriod(completed.completed_at, "semiannual"))))
    .toBeLessThan(5000);
  expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_payment_id = 'PAYTEST'").get())
    .toMatchObject({ amount_cents: 8390 });
  expect((await getPublicPixOrderStatus(c, reference)).status).toBe("paid");
  expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
  sqlite.close();
});
