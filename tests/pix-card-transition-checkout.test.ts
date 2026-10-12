import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { createCardPixTransitionCheckout, type PixPlanTransition } from "../src/lib/pix-plan-management";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, stripe_customer_id TEXT, updated_at TEXT);
    CREATE TABLE checkout_sessions (
      id INTEGER PRIMARY KEY, customer_id INTEGER, provider TEXT, provider_session_id TEXT,
      provider_session_url TEXT, provider_session_expires_at TEXT, provider_price_id TEXT,
      plan_tier TEXT, plan_type TEXT, mode TEXT, status TEXT, payment_status TEXT,
      operation_type TEXT, upgrade_license_id INTEGER, upgrade_processed_at TEXT,
      scheduled_renewal_license_id INTEGER, reactivation_license_id INTEGER,
      license_id INTEGER, renewal_applied_at TEXT,
      checkout_evidence_json TEXT, idempotency_key TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE UNIQUE INDEX idx_transition ON checkout_sessions(upgrade_license_id)
      WHERE operation_type = 'pix_plan_transition' AND upgrade_processed_at IS NULL
        AND status NOT IN ('expired','failed','canceled');
    INSERT INTO customers (id, email, stripe_customer_id) VALUES (3, 'someone@example.com', 'cus_test');
  `);
  sqlite.exec(readFileSync(new URL("../migrations/0080_license_checkout_exclusion.sql", import.meta.url), "utf8"));
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
  const c = { env: { merlin_db, STRIPE_SECRET_KEY: "sk_test_fake", PUBLIC_APP_ORIGIN: "https://example.com" } } as unknown as AppContext;
  const requests: URLSearchParams[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(new URLSearchParams(String(init?.body || "")));
    if (url.endsWith("/coupons")) return new Response(JSON.stringify({ id: "co_pix_credit" }), { status: 200 });
    return new Response(JSON.stringify({ id: "cs_test_transition", url: "https://checkout.stripe.test/session",
      status: "open", expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
  }));
  const quote = {
    license: { id: 7, name: "Customer", contact: "someone@example.com", customer_id: 3,
      billing_current_period_start: "2030-01-01T00:00:00.000Z", expires_at: "2030-02-01T00:00:00.000Z" },
    currentTier: "bronze", currentPeriod: "monthly", targetTier: "bronze", targetPeriod: "monthly",
    paymentMethod: "card", timing: "payment_method_only", targetPriceId: "price_card_bronze",
    targetPriceCents: 1490, amountDueNowCents: 0, nextRenewalAt: "2030-02-01T00:00:00.000Z",
    currentPeriodPriceCents: 1490, unusedPixCreditCents: 745,
  } as PixPlanTransition;
  return { sqlite, c, quote, requests };
}

describe("Pix to card Checkout", () => {
  test("collects the card without charging the already-paid Pix period", async () => {
    const { sqlite, c, quote, requests } = setup();
    const result = await createCardPixTransitionCheckout(c, quote);
    expect(result.checkoutSessionId).toBe("cs_test_transition");
    expect(requests).toHaveLength(1);
    expect(requests[0].get("mode")).toBe("setup");
    expect(requests[0].has("subscription_data[trial_end]")).toBe(false);
    expect(requests[0].has("line_items[1][price_data][unit_amount]")).toBe(false);
    expect(sqlite.prepare("SELECT operation_type, upgrade_license_id, provider_session_id FROM checkout_sessions").get())
      .toMatchObject({ operation_type: "pix_plan_transition", upgrade_license_id: 7, provider_session_id: "cs_test_transition" });
    sqlite.close();
  });

  test("discounts only the first recurring invoice using the unused paid Pix", async () => {
    const { sqlite, c, quote, requests } = setup();
    await createCardPixTransitionCheckout(c, { ...quote, targetTier: "prata", targetPriceId: "price_card_prata",
      targetPriceCents: 1990, amountDueNowCents: 1245, timing: "immediate" });
    expect(requests[0].get("amount_off")).toBe("745");
    expect(requests[0].get("duration")).toBe("once");
    expect(requests[1].get("mode")).toBe("subscription");
    expect(requests[1].get("line_items[0][price]")).toBe("price_card_prata");
    expect(requests[1].get("discounts[0][coupon]")).toBe("co_pix_credit");
    expect(requests[1].has("subscription_data[trial_end]")).toBe(false);
    expect(requests[1].has("line_items[1][price_data][unit_amount]")).toBe(false);
    sqlite.close();
  });

  test("uses card setup near Pix expiry without presenting the paid Pix period as a free trial", async () => {
    const { sqlite, c, quote, requests } = setup();
    const expiresAt = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    await createCardPixTransitionCheckout(c, { ...quote,
      license: { ...quote.license, expires_at: expiresAt }, nextRenewalAt: expiresAt });
    expect(requests[0].get("mode")).toBe("setup");
    expect(requests[0].has("subscription_data[trial_end]")).toBe(false);
    sqlite.close();
  });

  test("a waived first invoice still creates the subscription and collects the card", async () => {
    const { sqlite, c, quote, requests } = setup();
    await createCardPixTransitionCheckout(c, { ...quote, targetTier: "prata", targetPriceId: "price_card_prata",
      targetPriceCents: 1990, amountDueNowCents: 0, timing: "immediate" });
    expect(requests[0].get("amount_off")).toBe("1990");
    expect(requests[1].get("mode")).toBe("subscription");
    expect(requests[1].get("payment_method_collection")).toBe("always");
    sqlite.close();
  });

  test("paid migration remains a subscription even when the old Pix period has under 48 hours", async () => {
    const { sqlite, c, quote, requests } = setup();
    const expiresAt = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    await createCardPixTransitionCheckout(c, { ...quote, targetTier: "prata", targetPriceId: "price_card_prata",
      license: { ...quote.license, expires_at: expiresAt },
      targetPriceCents: 1990, amountDueNowCents: 1245, timing: "immediate" });
    expect(requests[1].get("mode")).toBe("subscription");
    expect(requests[1].has("subscription_data[trial_end]")).toBe(false);
    sqlite.close();
  });

  test("blocks an active Pix migration before Stripe's 24-hour cutoff", async () => {
    const { sqlite, c, quote, requests } = setup();
    await expect(createCardPixTransitionCheckout(c, { ...quote,
      license: { ...quote.license, expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
    })).rejects.toThrow("prazo");
    expect(requests).toHaveLength(0);
    expect(sqlite.prepare("SELECT count(*) AS count FROM checkout_sessions").get()).toMatchObject({ count: 0 });
    sqlite.close();
  });

  test("does not create a Checkout in the final 30 minutes of the Pix license", async () => {
    const { sqlite, c, quote, requests } = setup();
    await expect(createCardPixTransitionCheckout(c, { ...quote,
      license: { ...quote.license, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() },
    })).rejects.toThrow("prazo");
    expect(requests).toHaveLength(0);
    sqlite.close();
  });

  test("expired Pix starts a fresh subscription and charges its full first period", async () => {
    const { sqlite, c, quote, requests } = setup();
    await createCardPixTransitionCheckout(c, { ...quote, timing: "reactivation",
      license: { ...quote.license, expires_at: new Date(Date.now() - 60_000).toISOString() },
      amountDueNowCents: 1490,
      nextRenewalAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString() });
    expect(requests[0].get("mode")).toBe("subscription");
    expect(requests[0].get("line_items[0][price]")).toBe("price_card_bronze");
    expect(requests[0].has("subscription_data[trial_end]")).toBe(false);
    expect(requests[0].has("line_items[1][price_data][unit_amount]")).toBe(false);
    sqlite.close();
  });

  test("a new attempt immediately expires an unpaid card Checkout before replacing it", async () => {
    const { sqlite, c, quote } = setup();
    let nextSession = 0;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      paths.push(`${init?.method || "GET"} ${path}`);
      if (path === "/v1/checkout/sessions" && init?.method === "POST") {
        const id = `cs_replace_${++nextSession}`;
        return new Response(JSON.stringify({ id, url: `https://checkout.stripe.test/${id}`,
          status: "open", expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
      }
      if (path === "/v1/checkout/sessions/cs_replace_1" && !init?.method)
        return new Response(JSON.stringify({ status: "open" }), { status: 200 });
      if (path === "/v1/checkout/sessions/cs_replace_1/expire" && init?.method === "POST")
        return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
      throw new Error(`Unexpected Stripe request ${path}`);
    }));
    await createCardPixTransitionCheckout(c, quote);
    const replacement = await createCardPixTransitionCheckout(c, quote);
    expect(replacement.checkoutSessionId).toBe("cs_replace_2");
    expect(paths).toContain("POST /v1/checkout/sessions/cs_replace_1/expire");
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_replace_1'").get())
      .toMatchObject({ status: "expired" });
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_replace_2'").get())
      .toMatchObject({ status: "open" });
    sqlite.close();
  });

  test("a completed card Checkout is never expired or replaced", async () => {
    const { sqlite, c, quote } = setup();
    await createCardPixTransitionCheckout(c, quote);
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      paths.push(`${init?.method || "GET"} ${path}`);
      if (path === "/v1/checkout/sessions/cs_test_transition")
        return new Response(JSON.stringify({ id: "cs_test_transition", status: "complete",
          payment_status: "no_payment_required", customer: "cus_test", mode: "setup",
          setup_intent: "seti_paid" }), { status: 200 });
      throw new Error(`Unexpected Stripe request ${path}`);
    }));
    await expect(createCardPixTransitionCheckout(c, quote)).rejects.toThrow();
    expect(paths).not.toContain("POST /v1/checkout/sessions/cs_test_transition/expire");
    expect(paths).not.toContain("POST /v1/checkout/sessions");
    sqlite.close();
  });

  test("a payable Pix renewal blocks card Checkout before contacting Stripe", async () => {
    const { sqlite, c, quote, requests } = setup();
    sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, scheduled_renewal_license_id) VALUES (3, 'mercadopago', 'mp_order',
      'open', 'awaiting_payment', 7)`).run();
    await expect(createCardPixTransitionCheckout(c, quote)).rejects.toThrow("Ja existe");
    expect(requests).toHaveLength(0);
    sqlite.close();
  });

  test("a card Checkout blocks a simultaneous Pix reservation at the database layer", async () => {
    const { sqlite, c, quote } = setup();
    await createCardPixTransitionCheckout(c, quote);
    expect(() => sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, scheduled_renewal_license_id) VALUES (3, 'mercadopago', 'mp_order',
      'open', 'awaiting_payment', 7)`).run()).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  test("expired-license Pix and card reactivations cannot both be reserved", () => {
    const { sqlite } = setup();
    sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, reactivation_license_id) VALUES (3, 'stripe', 'cs_reactivate',
      'open', 'unpaid', 7)`).run();
    expect(() => sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, reactivation_license_id) VALUES (3, 'mercadopago', 'mp_reactivate',
      'open', 'awaiting_payment', 7)`).run()).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  test("an elapsed local timer does not release a payable Stripe session", async () => {
    const { sqlite, c, quote } = setup();
    sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, operation_type, upgrade_license_id, provider_session_expires_at)
      VALUES (3, 'stripe', 'cs_old', 'open', 'unpaid', 'pix_plan_transition', 7, ?)`)
      .run(new Date(Date.now() - 60_000).toISOString());
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/checkout/sessions/cs_old") && !init?.method) {
        return new Response(JSON.stringify({ id: "cs_old", status: "open" }), { status: 200 });
      }
      if (url.endsWith("/checkout/sessions/cs_old/expire")) {
        return new Response(JSON.stringify({ id: "cs_old", status: "expired" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "cs_new", url: "https://checkout.stripe.test/new",
        status: "open", expires_at: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
    }));
    const result = await createCardPixTransitionCheckout(c, quote);
    expect(result.checkoutSessionId).toBe("cs_new");
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_old'").get())
      .toMatchObject({ status: "expired" });
    sqlite.close();
  });

  test("provider uncertainty keeps the old reservation and does not open another Checkout", async () => {
    const { sqlite, c, quote } = setup();
    sqlite.prepare(`INSERT INTO checkout_sessions (customer_id, provider, provider_session_id,
      status, payment_status, operation_type, upgrade_license_id, provider_session_expires_at)
      VALUES (3, 'stripe', 'cs_old', 'open', 'unpaid', 'pix_plan_transition', 7, ?)`)
      .run(new Date(Date.now() - 60_000).toISOString());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCardPixTransitionCheckout(c, quote)).rejects.toThrow(/checkout anterior/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT status FROM checkout_sessions WHERE provider_session_id = 'cs_old'").get())
      .toMatchObject({ status: "open" });
    sqlite.close();
  });
});
