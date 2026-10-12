import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { processStripeWebhookEvent } from "../src/lib/stripe-webhook";
import { PIX_PLAN_TRANSITION_OPERATION } from "../src/lib/pix-plan-management";

afterEach(() => vi.unstubAllGlobals());

function setup(timing: "immediate" | "period_end" | "payment_method_only" | "early_renewal" | "reactivation", amountCents: number,
  collectionMode: "subscription" | "payment" | "setup" = "subscription") {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, email_normalized TEXT, stripe_customer_id TEXT);
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY, license_key TEXT, name TEXT, contact TEXT, hwid TEXT,
      expires_at TEXT, status TEXT, source TEXT, plan_tier TEXT, access_type TEXT,
      revoked_reason TEXT, revoked_origin TEXT, revoked_event_id TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_checkout_session_id TEXT,
      billing_current_period_start TEXT, billing_current_period_end TEXT,
      billing_cancel_at_period_end INTEGER, billing_status TEXT, updated_at TEXT
    );
    CREATE TABLE checkout_sessions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT, provider_session_id TEXT,
      provider_price_id TEXT, provider_subscription_id TEXT, plan_tier TEXT, plan_type TEXT,
      mode TEXT, status TEXT, payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      operation_type TEXT, upgrade_license_id INTEGER, upgrade_subscription_id TEXT, upgrade_processed_at TEXT,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_evidence_json TEXT, renewal_applied_at TEXT,
      completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, customer_id INTEGER UNIQUE, license_id INTEGER UNIQUE, provider TEXT,
      provider_subscription_id TEXT, status TEXT, current_period_end TEXT,
      cancel_at_period_end INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY, customer_id INTEGER, license_id INTEGER, provider TEXT,
      provider_payment_id TEXT, provider_checkout_session_id TEXT, provider_subscription_id TEXT,
      amount_cents INTEGER, currency TEXT, status TEXT, payment_type TEXT, created_at TEXT
    );
    CREATE TABLE payment_events (
      id INTEGER PRIMARY KEY, provider TEXT, provider_event_id TEXT UNIQUE,
      event_type TEXT, raw_created_at TEXT, processing_status TEXT,
      created_at TEXT, processed_at TEXT, error_message TEXT
    );
    CREATE TABLE billing_plan_prices (provider TEXT, payment_method TEXT, provider_price_id TEXT,
      plan_tier TEXT, billing_period TEXT, active INTEGER);
    CREATE TABLE subscription_plan_changes (id INTEGER PRIMARY KEY, license_id INTEGER,
      stripe_subscription_id TEXT, stripe_invoice_id TEXT, change_type TEXT,
      target_price_id TEXT, status TEXT, timing TEXT, effective_at TEXT, applied_at TEXT, updated_at TEXT,
      failure_reason TEXT);
    INSERT INTO billing_plan_prices VALUES ('stripe', 'card', 'price_prata', 'prata', 'monthly', 1);
    INSERT INTO customers (id, email, email_normalized, stripe_customer_id)
      VALUES (3, 'someone@example.com', 'someone@example.com', 'cus_test');
    INSERT INTO licenses (id, license_key, name, contact, hwid, expires_at, status, source,
      plan_tier, access_type, billing_current_period_start, billing_current_period_end, billing_status)
      VALUES (7, 'MERLIN-EXISTING', 'Customer', 'someone@example.com', 'existing-hwid',
        '2030-02-01T00:00:00.000Z', 'active', 'mercadopago_pix', 'bronze',
        'monthly_subscription', '2030-01-01T00:00:00.000Z', '2030-02-01T00:00:00.000Z', 'active');
  `);
  const evidence = {
    operation: PIX_PLAN_TRANSITION_OPERATION, paymentMethod: "card",
    currentTier: "bronze", currentPeriod: "monthly",
    currentPeriodStart: "2030-01-01T00:00:00.000Z", currentPeriodEnd: "2030-02-01T00:00:00.000Z",
    targetTier: "prata", targetPeriod: "monthly", targetFullPriceCents: 1990,
    amountCents, timing, nextRenewalAt: "2030-02-01T00:00:00.000Z", checkoutCollectionMode: collectionMode,
    firstInvoiceSubscription: collectionMode === "subscription" && (timing === "immediate" || timing === "reactivation"),
  };
  sqlite.prepare(`INSERT INTO checkout_sessions (id, customer_id, provider, provider_session_id,
    provider_price_id, plan_tier, plan_type, mode, status, payment_status,
    operation_type, upgrade_license_id, checkout_evidence_json)
    VALUES (8, 3, 'stripe', 'cs_test_change', 'price_prata', 'prata', 'monthly',
      ?, 'open', 'unpaid', ?, 7, ?)`)
    .run(collectionMode, PIX_PLAN_TRANSITION_OPERATION, JSON.stringify(evidence));
  const merlin_db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return sqlite.prepare(sql).get(...args as []) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...args as []) as T[] }; },
        async run() {
          const result = sqlite.prepare(sql).run(...args as []);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const stored = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE id = 8").get() as { checkout_evidence_json: string };
    const targetPeriod = JSON.parse(stored.checkout_evidence_json).targetPeriod;
    const paidStart = timing === "reactivation" ? "2030-02-01T00:00:00.000Z" : "2030-01-16T00:00:00.000Z";
    const paidEnd = timing === "reactivation" ? "2030-03-01T00:00:00.000Z"
      : targetPeriod === "semiannual" ? "2030-07-16T00:00:00.000Z" : "2030-02-16T00:00:00.000Z";
    return new Response(JSON.stringify(
    url.includes("/subscriptions/sub_test_change") && !url.includes("/subscriptions/sub_test_change/")
      ? { id: "sub_test_change", status: "active", current_period_start: Date.parse(paidStart) / 1000,
        current_period_end: Date.parse(paidEnd) / 1000, items: { data: [{ price: { id: "price_prata" } }] } }
      : url.includes("_intents/")
      ? { id: collectionMode === "setup" ? "seti_test" : "pi_test", status: "succeeded", payment_method: "pm_test" }
      : { id: "sub_test_change", status: "trialing" },
  ), { status: 200 });
  }));
  const c = { env: { merlin_db, STRIPE_SECRET_KEY: "sk_test_fake", PUBLIC_APP_ORIGIN: "https://example.com" },
    executionCtx: { waitUntil() {} } } as unknown as AppContext;
  const session = { id: "cs_test_change", status: "complete", payment_status: amountCents ? "paid" : "no_payment_required",
    amount_total: collectionMode === "setup" ? null : amountCents, currency: collectionMode === "setup" ? null : "brl",
    mode: collectionMode, subscription: collectionMode === "subscription" ? "sub_test_change" : null,
    payment_intent: collectionMode === "payment" ? "pi_test" : null,
    setup_intent: collectionMode === "setup" ? "seti_test" : null,
    customer: "cus_test", invoice: "in_initial" };
  return { sqlite, c, session };
}

describe("Pix-to-card webhook", () => {
  test("a late invoice from a canceled card subscription cannot overwrite a Pix reactivation", async () => {
    const { sqlite, c } = setup("immediate", 250);
    sqlite.prepare(`UPDATE checkout_sessions SET operation_type = 'initial', license_id = 7,
      provider_subscription_id = 'sub_old_card' WHERE id = 8`).run();
    sqlite.prepare(`UPDATE licenses SET source = 'mercadopago_pix', stripe_subscription_id = NULL,
      expires_at = '2030-03-01T00:00:00.000Z' WHERE id = 7`).run();
    await processStripeWebhookEvent(c, { id: "evt_late_old_card_invoice", type: "invoice.paid", data: { object: {
      id: "in_old_card", subscription: "sub_old_card", billing_reason: "subscription_cycle",
      customer: "cus_test", amount_paid: 1990, currency: "brl",
      lines: { data: [{ period: {
        start: Date.parse("2030-02-01T00:00:00.000Z") / 1000,
        end: Date.parse("2030-04-01T00:00:00.000Z") / 1000,
      } }] },
    } } });
    expect(sqlite.prepare("SELECT source, stripe_subscription_id, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ source: "mercadopago_pix", stripe_subscription_id: null,
        expires_at: "2030-03-01T00:00:00.000Z" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 0 });
    sqlite.close();
  });

  test("a refund of an old card payment cannot revoke a newly paid Pix period", async () => {
    const { sqlite, c } = setup("immediate", 250);
    sqlite.prepare(`INSERT INTO payments (customer_id, license_id, provider, provider_payment_id,
      status) VALUES (3, 7, 'stripe', 'ch_old_card', 'paid')`).run();
    await processStripeWebhookEvent(c, { id: "evt_old_card_refund", type: "charge.refunded", data: { object: {
      id: "ch_old_card", object: "charge", customer: "cus_test",
    } } });
    expect(sqlite.prepare("SELECT status, source, billing_status FROM licenses WHERE id = 7").get())
      .toMatchObject({ status: "active", source: "mercadopago_pix", billing_status: "active" });
    expect(sqlite.prepare("SELECT status FROM payments WHERE provider_payment_id = 'ch_old_card'").get())
      .toMatchObject({ status: "refunded" });
    sqlite.close();
  });

  test("applies a paid tier upgrade to the same key and HWID, then renews on the card", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_checkout", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT license_key, hwid, plan_tier, expires_at, stripe_subscription_id FROM licenses WHERE id = 7").get())
      .toMatchObject({ license_key: "MERLIN-EXISTING", hwid: "existing-hwid", plan_tier: "prata",
        expires_at: "2030-02-16T00:00:00.000Z", stripe_subscription_id: "sub_test_change" });
    expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_payment_id = 'in_initial'").get())
      .toMatchObject({ amount_cents: 1245 });
    const start = Date.parse("2030-02-16T00:00:00.000Z") / 1000;
    const end = Date.parse("2030-03-16T00:00:00.000Z") / 1000;
    await processStripeWebhookEvent(c, { id: "evt_renewal", type: "invoice.paid", data: { object: {
      id: "in_renewal", subscription: "sub_test_change", billing_reason: "subscription_cycle",
      customer: "cus_test", amount_paid: 1990, currency: "brl",
      lines: { data: [
        { type: "invoiceitem", proration: true, period: { start: start - 60, end: start + 60 } },
        { type: "subscription", subscription: "sub_test_change", period: { start, end } },
      ] },
    } } });
    expect(sqlite.prepare("SELECT license_key, hwid, plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ license_key: "MERLIN-EXISTING", hwid: "existing-hwid", plan_tier: "prata",
        expires_at: "2030-03-16T00:00:00.000Z" });
    sqlite.close();
  });

  test("records a zero-cash paid invoice as R$0 instead of its pre-credit total", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_initial_for_zero_invoice", type: "checkout.session.completed",
      data: { object: session } });
    const start = Date.parse("2030-02-16T00:00:00.000Z") / 1000;
    const end = Date.parse("2030-03-16T00:00:00.000Z") / 1000;
    await processStripeWebhookEvent(c, { id: "evt_zero_cash_invoice", type: "invoice.paid", data: { object: {
      id: "in_zero_cash", subscription: "sub_test_change", billing_reason: "subscription_cycle",
      customer: "cus_test", amount_paid: 0, total: 1000, currency: "brl",
      lines: { data: [{ type: "subscription", subscription: "sub_test_change", period: { start, end } }] },
    } } });
    expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_payment_id = 'in_zero_cash'").get())
      .toMatchObject({ amount_cents: 0 });
    sqlite.close();
  });

  test("a prepaid trial update invoice is not mistaken for a renewal", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_before_prepaid_trial_update", type: "checkout.session.completed",
      data: { object: session } });
    const before = sqlite.prepare("SELECT expires_at, billing_current_period_start FROM licenses WHERE id = 7")
      .get() as { expires_at: string; billing_current_period_start: string };
    const start = Date.parse("2030-01-16T00:00:00.000Z") / 1000;
    const end = Date.parse("2030-03-16T00:00:00.000Z") / 1000;
    await processStripeWebhookEvent(c, { id: "evt_prepaid_trial_update", type: "invoice.paid", data: { object: {
      id: "in_prepaid_trial_update", subscription: "sub_test_change", billing_reason: "subscription_update",
      customer: "cus_test", amount_paid: 0, currency: "brl",
      lines: { data: [{ type: "subscription", subscription: "sub_test_change", period: { start, end } }] },
    } } });
    expect(sqlite.prepare("SELECT expires_at, billing_current_period_start FROM licenses WHERE id = 7").get())
      .toMatchObject(before);
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments WHERE provider_payment_id = 'in_prepaid_trial_update'").get())
      .toMatchObject({ count: 0 });
    sqlite.close();
  });

  test("a failed plan-change invoice does not mark the already-paid term past due", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_first_checkout", type: "checkout.session.completed", data: { object: session } });
    sqlite.prepare(`INSERT INTO subscription_plan_changes (id, license_id, stripe_subscription_id,
      stripe_invoice_id, change_type, status) VALUES (1, 7, 'sub_test_change', 'in_change',
      'prepaid_first_card_invoice', 'pending_payment')`).run();
    await processStripeWebhookEvent(c, { id: "evt_change_failed", type: "invoice.payment_failed", data: { object: {
      id: "in_change", subscription: "sub_test_change", billing_reason: "subscription_update",
    } } });
    expect(sqlite.prepare("SELECT billing_status FROM licenses WHERE id = 7").get())
      .toMatchObject({ billing_status: "active" });
    expect(sqlite.prepare("SELECT status FROM subscription_plan_changes WHERE id = 1").get())
      .toMatchObject({ status: "payment_failed" });
    sqlite.close();
  });

  test("a failed regular renewal still marks card billing past due", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_regular_checkout", type: "checkout.session.completed", data: { object: session } });
    await processStripeWebhookEvent(c, { id: "evt_regular_failed", type: "invoice.payment_failed", data: { object: {
      id: "in_regular", subscription: "sub_test_change", billing_reason: "subscription_cycle",
    } } });
    expect(sqlite.prepare("SELECT billing_status FROM licenses WHERE id = 7").get())
      .toMatchObject({ billing_status: "past_due" });
    sqlite.close();
  });

  test("does not change the Pix tier for a downgrade before first full card renewal", async () => {
    const { sqlite, c, session } = setup("period_end", 0);
    await processStripeWebhookEvent(c, { id: "evt_checkout_free", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "bronze", expires_at: "2030-02-01T00:00:00.000Z" });
    expect(sqlite.prepare("SELECT renewal_applied_at FROM checkout_sessions WHERE id = 8").get())
      .toMatchObject({ renewal_applied_at: null });
    const start = Date.parse("2030-02-01T00:00:00.000Z") / 1000;
    const end = Date.parse("2030-03-01T00:00:00.000Z") / 1000;
    await processStripeWebhookEvent(c, { id: "evt_deferred_renewal", type: "invoice.paid", data: { object: {
      id: "in_deferred", subscription: "sub_test_change", billing_reason: "subscription_cycle",
      customer: "cus_test", amount_paid: 1990, currency: "brl",
      lines: { data: [{ period: { start, end } }] },
    } } });
    expect(sqlite.prepare("SELECT plan_tier, expires_at, license_key, hwid FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata", expires_at: "2030-03-01T00:00:00.000Z",
        license_key: "MERLIN-EXISTING", hwid: "existing-hwid" });
    expect(sqlite.prepare("SELECT renewal_applied_at FROM checkout_sessions WHERE id = 8").get())
      .toMatchObject({ renewal_applied_at: expect.any(String) });
    sqlite.close();
  });

  test("an unconfirmed card payment never changes the Pix license", async () => {
    const { sqlite, c, session } = setup("immediate", 250, "payment");
    await processStripeWebhookEvent(c, { id: "evt_unpaid", type: "checkout.session.completed", data: {
      object: { ...session, payment_status: "unpaid" },
    } });
    expect(sqlite.prepare("SELECT source, plan_tier, stripe_subscription_id FROM licenses WHERE id = 7").get())
      .toMatchObject({ source: "mercadopago_pix", plan_tier: "bronze", stripe_subscription_id: null });
    sqlite.close();
  });

  test("an unpaid first subscription invoice never activates a paid Pix-to-card upgrade", async () => {
    const { sqlite, c, session } = setup("immediate", 1245, "subscription");
    await processStripeWebhookEvent(c, { id: "evt_unpaid_subscription", type: "checkout.session.completed", data: {
      object: { ...session, payment_status: "unpaid" },
    } });
    expect(sqlite.prepare("SELECT source, plan_tier, expires_at, stripe_subscription_id FROM licenses WHERE id = 7").get())
      .toMatchObject({ source: "mercadopago_pix", plan_tier: "bronze",
        expires_at: "2030-02-01T00:00:00.000Z", stripe_subscription_id: null });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 0 });
    sqlite.close();
  });

  test("duplicate completed Checkout does not reapply or double-record the adjustment", async () => {
    const { sqlite, c, session } = setup("immediate", 1245);
    await processStripeWebhookEvent(c, { id: "evt_once", type: "checkout.session.completed", data: { object: session } });
    await processStripeWebhookEvent(c, { id: "evt_again", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata", expires_at: "2030-02-16T00:00:00.000Z" });
    sqlite.close();
  });

  test("setup-mode migration creates a subscription without charging the paid Pix period", async () => {
    const { sqlite, c, session } = setup("payment_method_only", 0, "setup");
    await processStripeWebhookEvent(c, { id: "evt_setup", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT stripe_subscription_id, license_key, hwid FROM licenses WHERE id = 7").get())
      .toMatchObject({ stripe_subscription_id: "sub_test_change", license_key: "MERLIN-EXISTING", hwid: "existing-hwid" });
    sqlite.close();
  });

  test("payment-mode migration charges only the adjustment and creates the card subscription", async () => {
    const { sqlite, c, session } = setup("immediate", 250, "payment");
    await processStripeWebhookEvent(c, { id: "evt_payment", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT stripe_subscription_id, plan_tier FROM licenses WHERE id = 7").get())
      .toMatchObject({ stripe_subscription_id: "sub_test_change", plan_tier: "prata" });
    expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_checkout_session_id = 'cs_test_change'").get())
      .toMatchObject({ amount_cents: 250 });
    sqlite.close();
  });

  test("a longer card period starts at confirmed payment, not when Checkout was opened", async () => {
    const { sqlite, c, session } = setup("immediate", 250);
    const row = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE id = 8").get() as { checkout_evidence_json: string };
    sqlite.prepare("UPDATE checkout_sessions SET checkout_evidence_json = ?, plan_type = 'semiannual', completed_at = ? WHERE id = 8")
      .run(JSON.stringify({ ...JSON.parse(row.checkout_evidence_json), targetPeriod: "semiannual",
        nextRenewalAt: "2030-07-15T00:00:00.000Z" }), "2030-01-16T00:00:00.000Z");
    await processStripeWebhookEvent(c, { id: "evt_longer_card", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT expires_at, billing_current_period_start FROM licenses WHERE id = 7").get())
      .toMatchObject({ expires_at: "2030-07-16T00:00:00.000Z",
        billing_current_period_start: "2030-01-16T00:00:00.000Z" });
    const updated = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE id = 8").get() as { checkout_evidence_json: string };
    expect(JSON.parse(updated.checkout_evidence_json).nextRenewalAt).toBe("2030-07-16T00:00:00.000Z");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url, init]) => String(url).includes("/subscriptions/sub_test_change")
      && init?.method === "POST" && new URLSearchParams(String(init.body)).has("trial_end"))).toBe(false);
    sqlite.close();
  });

  test("final-half-hour migration applies the tier now, prepays one term, and renews after it", async () => {
    const { sqlite, c, session } = setup("early_renewal", 1990, "payment");
    const row = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE id = 8").get() as { checkout_evidence_json: string };
    sqlite.prepare("UPDATE checkout_sessions SET checkout_evidence_json = ? WHERE id = 8")
      .run(JSON.stringify({ ...JSON.parse(row.checkout_evidence_json), nextRenewalAt: "2030-03-01T00:00:00.000Z" }));
    await processStripeWebhookEvent(c, { id: "evt_early", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT status, license_key, hwid, source, plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ status: "active", license_key: "MERLIN-EXISTING", hwid: "existing-hwid",
        source: "stripe", plan_tier: "prata", expires_at: "2030-03-01T00:00:00.000Z" });
    expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_checkout_session_id = 'cs_test_change'").get())
      .toMatchObject({ amount_cents: 1990 });
    const subscriptionCreate = vi.mocked(fetch).mock.calls.find(([url, init]) =>
      String(url).endsWith("/subscriptions") && init?.method === "POST");
    expect(new URLSearchParams(String(subscriptionCreate?.[1]?.body)).get("trial_end"))
      .toBe(String(Date.parse("2030-03-01T00:00:00.000Z") / 1000));
    await processStripeWebhookEvent(c, { id: "evt_early_again", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    sqlite.close();
  });

  test("expired Pix reactivation waits for payment and preserves the license identity", async () => {
    const { sqlite, c, session } = setup("reactivation", 1990);
    sqlite.prepare("UPDATE licenses SET status = 'expired' WHERE id = 7").run();
    await processStripeWebhookEvent(c, { id: "evt_reactivate_unpaid", type: "checkout.session.completed",
      data: { object: { ...session, payment_status: "unpaid" } } });
    expect(sqlite.prepare("SELECT status, source FROM licenses WHERE id = 7").get())
      .toMatchObject({ status: "expired", source: "mercadopago_pix" });
    await processStripeWebhookEvent(c, { id: "evt_reactivate_paid", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT status, source, license_key, hwid, plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ status: "active", source: "stripe", license_key: "MERLIN-EXISTING",
        hwid: "existing-hwid", plan_tier: "prata", expires_at: "2030-03-01T00:00:00.000Z" });
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).includes("/subscriptions/sub_test_change")
      && init?.method === "POST" && new URLSearchParams(String(init.body)).has("trial_end"))).toBe(false);
    await processStripeWebhookEvent(c, { id: "evt_reactivate_again", type: "checkout.session.completed", data: { object: session } });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    sqlite.close();
  });
});
