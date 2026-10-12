import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { getPublicPixOrderStatus, reconcileMercadoPagoCheckout } from "../src/lib/mercadopago-pix";

afterEach(() => vi.unstubAllGlobals());

function setup(stripeStatus: "active" | "canceled") {
  const sqlite = new DatabaseSync(":memory:");
  const reference = `mpix_${crypto.randomUUID()}`;
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, email_normalized TEXT,
      email_verified_at TEXT);
    CREATE TABLE licenses (id INTEGER PRIMARY KEY, license_key TEXT, name TEXT, contact TEXT,
      contact_type TEXT, recovery_pin_hash TEXT, recovery_notice_accepted_at TEXT, hwid TEXT,
      expires_at TEXT, status TEXT, revoked_reason TEXT, revoked_origin TEXT, revoked_event_id TEXT,
      source TEXT, plan_tier TEXT, premium_catalog_restricted INTEGER, customer_id INTEGER,
      access_type TEXT, billing_status TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT, billing_current_period_start TEXT, billing_current_period_end TEXT,
      billing_cancel_at_period_end INTEGER, updated_at TEXT);
    CREATE TABLE checkout_sessions (id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT,
      provider_session_id TEXT, provider_price_id TEXT, provider_payment_id TEXT,
      provider_external_reference TEXT, provider_qr_code TEXT, provider_qr_code_base64 TEXT,
      provider_ticket_url TEXT, provider_raw_status TEXT, provider_status_detail TEXT,
      provider_session_expires_at TEXT, provider_environment TEXT, plan_tier TEXT, plan_type TEXT,
      mode TEXT, status TEXT, payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      scheduled_renewal_license_id INTEGER, renewal_effective_at TEXT, renewal_applied_at TEXT,
      operation_type TEXT, upgrade_license_id INTEGER, upgrade_processed_at TEXT,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_evidence_json TEXT,
      processed_at TEXT, completed_at TEXT, updated_at TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, license_id INTEGER,
      provider TEXT, provider_payment_id TEXT UNIQUE, provider_checkout_session_id TEXT,
      provider_subscription_id TEXT, amount_cents INTEGER, currency TEXT, status TEXT,
      payment_type TEXT, created_at TEXT);
    INSERT INTO customers (id, email, email_normalized)
      VALUES (3, 'someone@example.com', 'someone@example.com');
    INSERT INTO licenses (id, license_key, name, contact, contact_type, expires_at, status,
      source, plan_tier, customer_id, access_type, billing_status, stripe_customer_id,
      stripe_subscription_id, billing_cancel_at_period_end)
      VALUES (7, 'MERLIN-EXISTING', 'Customer', 'someone@example.com', 'email',
        '2025-01-01T00:00:00.000Z', 'expired', 'stripe', 'bronze', 3,
        'monthly_subscription', 'canceled', 'cus_test', 'sub_old', 1);
  `);
  sqlite.prepare(`INSERT INTO checkout_sessions (id, customer_id, provider, provider_session_id,
    provider_price_id, provider_external_reference, provider_session_expires_at, provider_environment,
    plan_tier, plan_type, mode, status, payment_status, reactivation_license_id, pending_name,
    pending_recovery_pin_hash, checkout_evidence_json) VALUES (8, 3, 'mercadopago', 'ORDTEST',
    'pix:bronze:monthly', ?, ?, 'test', 'bronze', 'monthly', 'subscription', 'open',
    'awaiting_payment', 7, 'Customer', 'pin-hash', ?)`).run(reference,
    new Date(Date.now() + 30 * 60_000).toISOString(),
    JSON.stringify({ amountCents: 1490, currency: "brl", cardToPixVerified: true }));
  const merlin_db = { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() { return sqlite.prepare(sql).get(...args as []) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...args as []) as T[] }; },
      async run() { const result = sqlite.prepare(sql).run(...args as []);
        return { meta: { changes: Number(result.changes) } }; },
    };
  } };
  const c = { env: { merlin_db, ENVIRONMENT: "staging", PIX_ENABLED: "true",
    PIX_PROVIDER: "mercadopago", PIX_ENV: "test", MERCADO_PAGO_TEST_ACCESS_TOKEN: "fake",
    MERCADO_PAGO_API_BASE: "https://mp.example", STRIPE_SECRET_KEY: "sk_test_fake" },
    executionCtx: { waitUntil() {} } } as unknown as AppContext;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/subscriptions/sub_old")) return new Response(JSON.stringify({
      id: "sub_old", customer: "cus_test", status: stripeStatus,
      ended_at: Date.now() / 1000 - 60,
    }), { status: 200 });
    if (url.includes("/invoices?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: "ORDTEST", external_reference: reference,
      status: "processed", status_detail: "accredited", total_amount: "14.90",
      total_paid_amount: "14.90", currency: "BRL",
      transactions: { payments: [{ id: "PAYTEST", payment_method: { id: "pix" } }] },
    }), { status: 200 });
  }));
  return { sqlite, c, reference };
}

describe("card to Pix settlement", () => {
  test("an old card subscription reactivated after QR creation cannot be overwritten", async () => {
    const { sqlite, c, reference } = setup("active");
    const result = await getPublicPixOrderStatus(c, reference);
    expect(result.status).not.toBe("paid");
    expect(sqlite.prepare("SELECT source, stripe_subscription_id FROM licenses WHERE id = 7").get())
      .toMatchObject({ source: "stripe", stripe_subscription_id: "sub_old" });
    sqlite.close();
  });

  test("an ended card subscription with no outstanding invoice can be replaced once", async () => {
    const { sqlite, c, reference } = setup("canceled");
    await reconcileMercadoPagoCheckout(c, "ORDTEST");
    expect((await getPublicPixOrderStatus(c, reference)).status).toBe("paid");
    expect(sqlite.prepare("SELECT source, stripe_subscription_id FROM licenses WHERE id = 7").get())
      .toMatchObject({ source: "mercadopago_pix", stripe_subscription_id: null });
    sqlite.close();
  });
});
