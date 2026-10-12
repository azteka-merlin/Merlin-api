import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { createPrepaidCardChangeCheckout, getPrepaidCardContext,
  previewPrepaidCardChange } from "../src/lib/prepaid-card-change";
import { processStripeWebhookEvent } from "../src/lib/stripe-webhook";
import { previewSubscriptionPlanChange } from "../src/lib/subscription-plan-change";
import { createPublicAccessPlanChangeForLicense, previewPublicAccessPlanChangeForLicense } from "../src/lib/public-access-management";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE licenses (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, source TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, plan_tier TEXT, access_type TEXT,
      expires_at TEXT, billing_status TEXT, billing_cancel_at_period_end INTEGER,
      billing_current_period_start TEXT, billing_current_period_end TEXT, updated_at TEXT);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, email_normalized TEXT, stripe_customer_id TEXT);
    CREATE TABLE checkout_sessions (id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT,
      provider_session_id TEXT, provider_session_url TEXT, provider_session_expires_at TEXT,
      provider_price_id TEXT, provider_subscription_id TEXT, plan_tier TEXT, plan_type TEXT,
      mode TEXT, status TEXT, payment_status TEXT, license_id INTEGER, reactivation_license_id INTEGER,
      operation_type TEXT, upgrade_license_id INTEGER, upgrade_subscription_id TEXT, upgrade_processed_at TEXT,
      pending_license_key TEXT, pending_name TEXT, pending_recovery_pin_hash TEXT,
      pending_recovery_notice_accepted_at TEXT, checkout_evidence_json TEXT, renewal_applied_at TEXT,
      idempotency_key TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, customer_id INTEGER UNIQUE, license_id INTEGER UNIQUE,
      provider TEXT, provider_subscription_id TEXT, status TEXT, current_period_end TEXT,
      cancel_at_period_end INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER, license_id INTEGER,
      provider TEXT, provider_payment_id TEXT UNIQUE, provider_checkout_session_id TEXT,
      provider_subscription_id TEXT, amount_cents INTEGER, currency TEXT, status TEXT,
      payment_type TEXT, created_at TEXT);
    CREATE TABLE payment_events (id INTEGER PRIMARY KEY, provider TEXT, provider_event_id TEXT UNIQUE,
      event_type TEXT, raw_created_at TEXT, processing_status TEXT, created_at TEXT,
      processed_at TEXT, error_message TEXT);
    CREATE TABLE subscription_plan_changes (
      id INTEGER PRIMARY KEY, license_id INTEGER, customer_id INTEGER, provider TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_subscription_item_id TEXT,
      stripe_invoice_id TEXT, stripe_schedule_id TEXT,
      stripe_payment_intent_id TEXT, current_plan_tier TEXT, target_plan_tier TEXT,
      current_billing_period TEXT, target_billing_period TEXT, current_price_id TEXT,
      target_price_id TEXT, change_type TEXT, timing TEXT, status TEXT, requested_at TEXT,
      effective_at TEXT, raw_json TEXT, applied_at TEXT, created_at TEXT, updated_at TEXT, failure_reason TEXT
    );
    INSERT INTO customers VALUES (3, 'buyer@example.com', 'buyer@example.com', 'cus_test');
  `);
  const now = new Date();
  const originalStart = new Date(now.getTime() - 15 * 86400_000).toISOString();
  const migratedAt = new Date(now.getTime() - 10 * 86400_000).toISOString();
  const renewalAt = new Date(now.getTime() + 16 * 86400_000).toISOString();
  sqlite.prepare(`INSERT INTO licenses (id, customer_id, status, source, stripe_customer_id,
    stripe_subscription_id, plan_tier, access_type, expires_at, billing_status,
    billing_cancel_at_period_end, billing_current_period_start, billing_current_period_end)
    VALUES (7, 3, 'active', 'stripe', 'cus_test', 'sub_prepaid', 'prata',
      'monthly_subscription', ?, 'active', 0, ?, ?)`).run(renewalAt, originalStart, renewalAt);
  const initialEvidence = {
    operation: "pix_plan_transition", paymentMethod: "card", currentTier: "bronze",
    currentPeriod: "monthly", currentPeriodStart: originalStart, currentPeriodEnd: renewalAt,
    targetTier: "prata", targetPeriod: "monthly", targetFullPriceCents: 1990,
    currentPeriodPriceCents: 1490, unusedPixCreditCents: 1250,
    amountCents: 250, timing: "immediate", nextRenewalAt: renewalAt,
    checkoutCollectionMode: "subscription",
  };
  sqlite.prepare(`INSERT INTO checkout_sessions (id, customer_id, provider, provider_session_id,
    provider_price_id, provider_subscription_id, plan_tier, plan_type, mode, status,
    payment_status, license_id, operation_type, upgrade_license_id,
    upgrade_processed_at, checkout_evidence_json, completed_at)
    VALUES (8, 3, 'stripe', 'cs_migration', 'price_prata_monthly', 'sub_prepaid',
      'prata', 'monthly', 'subscription', 'completed', 'paid', 7,
      'pix_plan_transition', 7, ?, ?, ?)`)
    .run(migratedAt, JSON.stringify(initialEvidence), migratedAt);
  sqlite.prepare(`INSERT INTO subscriptions (customer_id, license_id, provider,
    provider_subscription_id, status, current_period_end, cancel_at_period_end)
    VALUES (3, 7, 'stripe', 'sub_prepaid', 'trialing', ?, 0)`).run(renewalAt);
  const billing = { id: 1, billing_enabled: 1, public_signup_enabled: 1, plans_enabled: 1,
    monthly_enabled: 1, semiannual_enabled: 1, annual_enabled: 1, lifetime_enabled: 0,
    pix_enabled: 1, pix_monthly_enabled: 1, pix_semiannual_enabled: 1,
    pix_annual_enabled: 1, pix_lifetime_enabled: 0, monthly_card_trial_enabled: 0,
    monthly_card_trial_days: 30, staging_email_delivery_enabled: 0,
    monthly_price_id: null, annual_price_id: null, lifetime_price_id: null,
    pix_annual_price_id: null, pix_lifetime_price_id: null, currency: "brl", free_access_type: "free",
    free_duration_days: null, premium_catalog_cutoff_at: null, updated_at: migratedAt };
  const prices: Record<string, { provider_price_id: string; amount_cents: number; currency: string; active: number;
    plan_tier: string; billing_period: string }> = {
    "bronze:monthly": { provider_price_id: "price_bronze_monthly", amount_cents: 1490, currency: "brl", active: 1,
      plan_tier: "bronze", billing_period: "monthly" },
    "ouro:monthly": { provider_price_id: "price_ouro_monthly", amount_cents: 2490, currency: "brl", active: 1,
      plan_tier: "ouro", billing_period: "monthly" },
    "ouro:semiannual": { provider_price_id: "price_ouro_semiannual", amount_cents: 11990, currency: "brl", active: 1,
      plan_tier: "ouro", billing_period: "semiannual" },
    "prata:annual": { provider_price_id: "price_prata_annual", amount_cents: 19990, currency: "brl", active: 1,
      plan_tier: "prata", billing_period: "annual" },
    "ouro:annual": { provider_price_id: "price_ouro_annual", amount_cents: 24990, currency: "brl", active: 1,
      plan_tier: "ouro", billing_period: "annual" },
  };
  const merlin_db = { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() {
        if (sql.includes("FROM billing_settings")) return billing as T;
        if (sql.includes("FROM billing_plan_prices")) {
          const value = args.length === 2
            ? Object.values(prices).find((price) => price.provider_price_id === args[1])
            : prices[`${args[2]}:${args[3]}`];
          return (value || null) as T | null;
        }
        return (sqlite.prepare(sql).get(...args as []) || null) as T | null;
      },
      async all<T>() { return { results: sqlite.prepare(sql).all(...args as []) as T[] }; },
      async run() {
        const result = sqlite.prepare(sql).run(...args as []);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
  } };
  const state = { priceId: "price_prata_monthly", trialEnd: Math.floor(Date.parse(renewalAt) / 1000),
    status: "trialing", firstPeriodEnd: renewalAt };
  const schedulePhaseStart = Math.floor(Date.now() / 1000) - 20 * 86400;
  const requests: Array<{ path: string; method: string; params: URLSearchParams }> = [];
  let checkoutCounter = 0;
  const sessionStates = new Map<string, "open" | "expired" | "complete">();
  let completeDuringExpire = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method || "GET";
    const params = new URLSearchParams(String(init?.body || ""));
    requests.push({ path, method, params });
    if (path === "/v1/checkout/sessions") {
      const id = `cs_prepaid_${++checkoutCounter}`;
      sessionStates.set(id, "open");
      return new Response(JSON.stringify({ id, url: "https://checkout.stripe.test/prepaid", status: "open",
        expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
    }
    const checkoutMatch = path.match(/^\/v1\/checkout\/sessions\/(cs_prepaid_\d+)(\/expire)?$/);
    if (checkoutMatch) {
      const id = checkoutMatch[1];
      if (checkoutMatch[2]) {
        if (completeDuringExpire) {
          sessionStates.set(id, "complete");
          return new Response(JSON.stringify({ error: { message: "Already complete" } }), { status: 400 });
        }
        if (sessionStates.get(id) !== "open")
          return new Response(JSON.stringify({ error: { message: "Not open" } }), { status: 400 });
        sessionStates.set(id, "expired");
        return new Response(JSON.stringify({ id, status: "expired" }), { status: 200 });
      }
      const row = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE provider_session_id = ?")
        .get(id) as { checkout_evidence_json: string };
      const evidence = JSON.parse(row.checkout_evidence_json) as { amountDueNowCents: number; checkoutMode: string };
      return new Response(JSON.stringify({ id, status: sessionStates.get(id),
        mode: evidence.checkoutMode, customer: "cus_test",
        payment_status: sessionStates.get(id) === "complete" ? "paid" : "unpaid",
        amount_total: evidence.amountDueNowCents, currency: "brl",
        payment_intent: `pi_prepaid_${id.split("_").at(-1)}`,
      }), { status: 200 });
    }
    if (path.startsWith("/v1/payment_intents/pi_prepaid_")) return new Response(JSON.stringify({
      id: path.split("/").at(-1), status: "succeeded", payment_method: "pm_saved",
    }), { status: 200 });
    if (path === "/v1/setup_intents/seti_prepaid") return new Response(JSON.stringify({
      id: "seti_prepaid", status: "succeeded", payment_method: "pm_saved",
    }), { status: 200 });
    if (path === "/v1/subscription_schedules") {
      return new Response(JSON.stringify({ id: "sched_prepaid", status: "active",
        subscription: "sub_prepaid", current_phase: { start_date: schedulePhaseStart,
          end_date: Math.floor(Date.parse(state.firstPeriodEnd) / 1000) }, phases: [{
          start_date: schedulePhaseStart,
          end_date: Math.floor(Date.parse(state.firstPeriodEnd) / 1000),
          items: [{ price: state.priceId }],
        }] }), { status: 200 });
    }
    if (path === "/v1/subscription_schedules/sched_prepaid"
      || path === "/v1/subscription_schedules/sched_prepaid/release") {
      if (path === "/v1/subscription_schedules/sched_prepaid"
        && params.get("phases[0][start_date]") !== String(schedulePhaseStart)) {
        return new Response(JSON.stringify({ error: {
          message: "You can not modify the start date of the current phase.",
        } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: "sched_prepaid" }), { status: 200 });
    }
    if (path === "/v1/subscriptions/sub_prepaid") {
      if (method === "POST") {
        state.priceId = params.get("items[0][price]") || state.priceId;
        state.trialEnd = Number(params.get("trial_end"));
        state.firstPeriodEnd = new Date(state.trialEnd * 1000).toISOString();
      }
      return new Response(JSON.stringify({ id: "sub_prepaid", customer: "cus_test", status: state.status,
        pending_update: null, trial_end: state.trialEnd,
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.parse(state.firstPeriodEnd) / 1000),
        cancel_at_period_end: false,
        items: { data: [{ id: "si_test", price: { id: state.priceId } }] },
      }), { status: 200 });
    }
    throw new Error(`Unexpected Stripe path ${path}`);
  }));
  const c = { env: { merlin_db, STRIPE_SECRET_KEY: "sk_test_fake", PUBLIC_APP_ORIGIN: "https://example.test" },
    executionCtx: { waitUntil() {} } } as unknown as AppContext;
  return { sqlite, c, state, requests, renewalAt, schedulePhaseStart, sessionStates,
    setCompleteDuringExpire(value: boolean) { completeDuringExpire = value; } };
}

describe("prepaid Pix credit after migrating to card", () => {
  test("a card downgrade during the prepaid period is scheduled without charging or touching Pix", async () => {
    const { sqlite, c, requests, renewalAt, schedulePhaseStart } = setup();
    const preview = await previewPublicAccessPlanChangeForLicense(c, 7,
      { targetTier: "bronze", targetPeriod: "monthly" });
    expect(preview).toMatchObject({ timing: "period_end", changeType: "downgrade",
      amountDueNowCents: null });

    const license = sqlite.prepare("SELECT * FROM licenses WHERE id = 7").get();
    const result = await createPublicAccessPlanChangeForLicense(c, license as any,
      { targetTier: "bronze", targetPeriod: "monthly" });
    expect(result).toMatchObject({ status: "scheduled", timing: "period_end", scheduleId: "sched_prepaid" });
    expect(sqlite.prepare("SELECT plan_tier FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 0 });
    const schedule = requests.find((request) => request.path === "/v1/subscription_schedules/sched_prepaid"
      && request.method === "POST");
    const renewalSeconds = Math.floor(Date.parse(renewalAt) / 1000);
    expect(schedule?.params.get("phases[0][trial_end]")).toBe(String(renewalSeconds));
    expect(schedule?.params.get("phases[0][start_date]")).toBe(String(schedulePhaseStart));
    expect(schedule?.params.get("phases[0][end_date]")).toBe(String(renewalSeconds));
    expect(schedule?.params.get("phases[1][items][0][price]")).toBe("price_bronze_monthly");
    expect(requests.some((request) => request.path === "/v1/checkout/sessions" )).toBe(false);
    sqlite.close();
  });

  test("scheduling a downgrade expires an abandoned card-upgrade Checkout first", async () => {
    const { sqlite, c, requests } = setup();
    await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    const license = sqlite.prepare("SELECT * FROM licenses WHERE id = 7").get();
    const result = await createPublicAccessPlanChangeForLicense(c, license as any,
      { targetTier: "bronze", targetPeriod: "monthly" });
    expect(result.status).toBe("scheduled");
    expect(requests.some((request) => request.path === "/v1/checkout/sessions/cs_prepaid_1/expire")).toBe(true);
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_1'").get())
      .toMatchObject({ status: "expired" });
    sqlite.close();
  });

  test("a shorter card period after a prepaid upgrade is scheduled, not charged immediately", async () => {
    const { sqlite, c, requests } = setup();
    const first = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "annual" });
    await processStripeWebhookEvent(c, { id: "evt_annual_upgrade", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: first.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_1",
    } } });
    const preview = await previewPublicAccessPlanChangeForLicense(c, 7,
      { targetTier: "ouro", targetPeriod: "monthly" });
    expect(preview).toMatchObject({ timing: "period_end", changeType: "interval_change",
      amountDueNowCents: null });
    const license = sqlite.prepare("SELECT * FROM licenses WHERE id = 7").get();
    const result = await createPublicAccessPlanChangeForLicense(c, license as any,
      { targetTier: "ouro", targetPeriod: "monthly" });
    expect(result.status).toBe("scheduled");
    expect(requests.find((request) => request.path === "/v1/subscription_schedules/sched_prepaid"
      && request.method === "POST")?.params.get("phases[1][items][0][price]"))
      .toBe("price_ouro_monthly");
    expect(sqlite.prepare("SELECT access_type FROM licenses WHERE id = 7").get())
      .toMatchObject({ access_type: "annual_subscription" });
    sqlite.close();
  });

  test("Bronze Pix to same Bronze card then Gold charges R$10 in hosted Checkout before upgrading", async () => {
    const { sqlite, c, state, requests } = setup();
    const justPaidAt = new Date(Date.now() - 60_000).toISOString();
    const renewalAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    sqlite.prepare(`UPDATE licenses SET plan_tier = 'bronze', expires_at = ?,
      billing_current_period_start = ?, billing_current_period_end = ? WHERE id = 7`)
      .run(renewalAt, justPaidAt, renewalAt);
    state.priceId = "price_bronze_monthly";
    state.trialEnd = Math.floor(Date.parse(renewalAt) / 1000);
    const migration = sqlite.prepare("SELECT checkout_evidence_json FROM checkout_sessions WHERE id = 8")
      .get() as { checkout_evidence_json: string };
    const evidence = { ...JSON.parse(migration.checkout_evidence_json), currentPeriodStart: justPaidAt,
      currentPeriodEnd: renewalAt, nextRenewalAt: renewalAt, targetTier: "bronze",
      targetFullPriceCents: 1490, amountCents: 0, timing: "payment_method_only",
      checkoutCollectionMode: "setup", firstInvoiceSubscription: false };
    sqlite.prepare(`UPDATE checkout_sessions SET provider_price_id = 'price_bronze_monthly',
      mode = 'setup', payment_status = 'no_payment_required', checkout_evidence_json = ?,
      completed_at = ? WHERE id = 8`)
      .run(JSON.stringify(evidence), justPaidAt);
    const preview = await previewPrepaidCardChange(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    expect(preview.amountDueNowCents).toBeGreaterThanOrEqual(1000);
    expect(preview.amountDueNowCents).toBeLessThanOrEqual(1001);
    const result = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/prepaid");
    expect(requests.find((request) => request.path === "/v1/checkout/sessions")?.params
      .get("line_items[0][price_data][unit_amount]")).toBe(String(preview.amountDueNowCents));
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "bronze", expires_at: renewalAt });
    await processStripeWebhookEvent(c, { id: "evt_bronze_to_gold", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: result.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_1",
    } } });
    expect(sqlite.prepare("SELECT plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({ plan_tier: "ouro" });
    expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE provider_payment_id = 'pi_prepaid_1'").get())
      .toMatchObject({ amount_cents: result.amountDueNowCents });
    sqlite.close();
  });

  test("opens a Stripe payment Checkout without changing the plan or charging the saved card", async () => {
    const { sqlite, c, requests, renewalAt } = setup();
    const preview = await previewPrepaidCardChange(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    const result = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    expect(result).toMatchObject({ status: "pending_payment", checkoutUrl: "https://checkout.stripe.test/prepaid" });
    const checkout = requests.find((request) => request.path === "/v1/checkout/sessions");
    expect(checkout?.params.get("mode")).toBe("payment");
    expect(checkout?.params.get("line_items[0][price_data][unit_amount]")).toBe(String(preview.amountDueNowCents));
    expect(requests.some((request) => request.path === "/v1/subscriptions/sub_prepaid" && request.method === "POST")).toBe(false);
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata", expires_at: renewalAt });
    const replacement = await createPrepaidCardChangeCheckout(c, { licenseId: 7,
      targetTier: "ouro", targetPeriod: "monthly" });
    expect(replacement.status).toBe("pending_payment");
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_1'").get())
      .toMatchObject({ status: "expired" });
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_2'").get())
      .toMatchObject({ status: "open" });
    expect(requests.some((request) => request.path === "/v1/checkout/sessions/cs_prepaid_1/expire"
      && request.method === "POST")).toBe(true);
    sqlite.close();
  });

  test("only a confirmed Checkout applies the upgrade and keeps credit for a later change", async () => {
    const { sqlite, c, state, requests } = setup();
    const result = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    const event = { id: "evt_prepaid_paid", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: result.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_1",
    } } };
    await processStripeWebhookEvent(c, event);
    expect(sqlite.prepare("SELECT plan_tier, access_type, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "ouro", access_type: "monthly_subscription" });
    const license = sqlite.prepare("SELECT expires_at FROM licenses WHERE id = 7").get() as { expires_at: string };
    expect(Math.abs(Date.parse(license.expires_at) - Date.parse(state.firstPeriodEnd))).toBeLessThan(1000);
    expect(requests.find((request) => request.path === "/v1/subscriptions/sub_prepaid" && request.method === "POST")
      ?.params.get("proration_behavior")).toBe("none");
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    await processStripeWebhookEvent(c, event);
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    expect(await getPrepaidCardContext(c, 7)).not.toBeNull();
    const second = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "annual" });
    expect(second.status).toBe("pending_payment");
    expect(sqlite.prepare("SELECT access_type FROM licenses WHERE id = 7").get())
      .toMatchObject({ access_type: "monthly_subscription" });
    await processStripeWebhookEvent(c, { id: "evt_prepaid_second", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_2", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: second.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_2",
    } } });
    expect(sqlite.prepare("SELECT plan_tier, access_type FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "ouro", access_type: "annual_subscription" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 2 });
    await expect(previewSubscriptionPlanChange(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "annual" }))
      .rejects.toThrow("A licenca ja esta neste plano.");
    sqlite.close();
  });

  test("a paid second change survives Stripe rounding the prior renewal to whole seconds", async () => {
    const { sqlite, c } = setup();
    const first = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    await processStripeWebhookEvent(c, { id: "evt_first_before_rounding", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: first.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_1",
    } } });
    const firstRenewal = (sqlite.prepare("SELECT expires_at FROM licenses WHERE id = 7").get() as { expires_at: string }).expires_at;
    const roundedRenewal = new Date(Math.floor(Date.parse(firstRenewal) / 1000) * 1000).toISOString();
    sqlite.prepare("UPDATE licenses SET expires_at = ?, billing_current_period_end = ? WHERE id = 7")
      .run(roundedRenewal, roundedRenewal);
    const second = await createPrepaidCardChangeCheckout(c, { licenseId: 7,
      targetTier: "ouro", targetPeriod: "semiannual" });
    await processStripeWebhookEvent(c, { id: "evt_second_after_rounding", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_2", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: second.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_2",
    } } });
    expect(sqlite.prepare("SELECT plan_tier, access_type, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "ouro", access_type: "semiannual_subscription" });
    expect(sqlite.prepare("SELECT status, upgrade_processed_at FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_2'").get())
      .toMatchObject({ status: "completed", upgrade_processed_at: expect.any(String) });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 2 });
    sqlite.close();
  });

  test("a genuinely changed renewal remains blocked after payment", async () => {
    const { sqlite, c, renewalAt } = setup();
    const checkout = await createPrepaidCardChangeCheckout(c, { licenseId: 7,
      targetTier: "ouro", targetPeriod: "monthly" });
    sqlite.prepare("UPDATE licenses SET expires_at = ? WHERE id = 7")
      .run(new Date(Date.parse(renewalAt) + 2_000).toISOString());
    const event = { id: "evt_changed_renewal", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "paid", amount_total: checkout.amountDueNowCents, currency: "brl",
      payment_intent: "pi_prepaid_1",
    } } };
    await expect(processStripeWebhookEvent(c, event)).rejects.toThrow("stale plan details");
    expect(sqlite.prepare("SELECT access_type FROM licenses WHERE id = 7").get())
      .toMatchObject({ access_type: "monthly_subscription" });
    expect(sqlite.prepare("SELECT upgrade_processed_at FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_1'").get())
      .toMatchObject({ upgrade_processed_at: null });
    sqlite.prepare("UPDATE licenses SET expires_at = ? WHERE id = 7").run(renewalAt);
    await processStripeWebhookEvent(c, event);
    expect(sqlite.prepare("SELECT status, upgrade_processed_at FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_1'").get())
      .toMatchObject({ status: "completed", upgrade_processed_at: expect.any(String) });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments WHERE provider_payment_id = 'pi_prepaid_1'").get())
      .toMatchObject({ count: 1 });
    sqlite.close();
  });

  test("rejects a webhook with a different paid amount and leaves the old plan intact", async () => {
    const { sqlite, c, renewalAt } = setup();
    const result = await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    await expect(processStripeWebhookEvent(c, { id: "evt_wrong_amount", type: "checkout.session.completed",
      data: { object: { id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
        payment_status: "paid", amount_total: result.amountDueNowCents + 1, currency: "brl",
        payment_intent: "pi_prepaid_1" } } })).rejects.toThrow("amount or currency mismatch");
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata", expires_at: renewalAt });
    expect(sqlite.prepare("SELECT upgrade_processed_at FROM checkout_sessions WHERE provider_session_id = 'cs_prepaid_1'").get())
      .toMatchObject({ upgrade_processed_at: null });
    sqlite.close();
  });

  test("an unpaid or canceled Stripe visit never upgrades the license", async () => {
    const { sqlite, c, renewalAt, requests } = setup();
    await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    await processStripeWebhookEvent(c, { id: "evt_prepaid_unpaid", type: "checkout.session.completed", data: { object: {
      id: "cs_prepaid_1", status: "complete", mode: "payment", customer: "cus_test",
      payment_status: "unpaid", amount_total: 1240, currency: "brl",
    } } });
    expect(sqlite.prepare("SELECT plan_tier, expires_at FROM licenses WHERE id = 7").get())
      .toMatchObject({ plan_tier: "prata", expires_at: renewalAt });
    expect(sqlite.prepare("SELECT count(*) AS count FROM payments").get()).toMatchObject({ count: 0 });
    expect(requests.some((request) => request.path === "/v1/subscriptions/sub_prepaid" && request.method === "POST"))
      .toBe(false);
    sqlite.close();
  });

  test("a completed prior Checkout is reconciled, never expired or replaced", async () => {
    const { sqlite, c, requests, sessionStates } = setup();
    await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    sessionStates.set("cs_prepaid_1", "complete");
    await expect(createPrepaidCardChangeCheckout(c, { licenseId: 7,
      targetTier: "ouro", targetPeriod: "monthly" })).rejects.toThrow("checkout anterior foi concluido");
    expect(requests.filter((request) => request.path === "/v1/checkout/sessions" && request.method === "POST"))
      .toHaveLength(1);
    expect(requests.some((request) => request.path.endsWith("/expire"))).toBe(false);
    expect(sqlite.prepare("SELECT plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({ plan_tier: "ouro" });
    sqlite.close();
  });

  test("payment completing between status check and expiry is never canceled", async () => {
    const { sqlite, c, requests, setCompleteDuringExpire } = setup();
    await createPrepaidCardChangeCheckout(c, { licenseId: 7, targetTier: "ouro", targetPeriod: "monthly" });
    setCompleteDuringExpire(true);
    await expect(createPrepaidCardChangeCheckout(c, { licenseId: 7,
      targetTier: "ouro", targetPeriod: "monthly" })).rejects.toThrow("checkout anterior foi concluido");
    expect(requests.filter((request) => request.path === "/v1/checkout/sessions" && request.method === "POST"))
      .toHaveLength(1);
    expect(sqlite.prepare("SELECT plan_tier FROM licenses WHERE id = 7").get()).toMatchObject({ plan_tier: "ouro" });
    sqlite.close();
  });
});
