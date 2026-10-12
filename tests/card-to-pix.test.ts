import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";
import { assertExpiredCardToPixReady, assertNoPendingPixReactivation } from "../src/lib/card-to-pix";

const reconcileStripeCheckoutSession = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/stripe-webhook", () => ({ reconcileStripeCheckoutSession }));

afterEach(() => {
  vi.unstubAllGlobals();
  reconcileStripeCheckoutSession.mockReset();
});

const expiry = "2026-09-03T02:59:59.999Z";
const license = { id: 7, status: "expired", expires_at: expiry, billing_status: "canceled",
  stripe_customer_id: "cus_test", stripe_subscription_id: "sub_test",
  access_type: "monthly_subscription" };

type Checkout = {
  id: number;
  provider_session_id: string | null;
  status: string;
  payment_status: string | null;
};

function setup(input: {
  subscriptionStatus?: string;
  endedAt?: number;
  customer?: string;
  openInvoice?: boolean;
  draftInvoice?: boolean;
  pendingCheckout?: boolean;
  pendingPix?: boolean;
  checkoutStatus?: string;
  checkoutPaymentStatus?: string | null;
  stripeCheckoutStatus?: string;
  expireRace?: "complete" | "expired";
  expireFails?: boolean;
  stripeKey?: string;
} = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  const checkouts: Checkout[] = input.pendingCheckout ? [{
    id: 9,
    provider_session_id: "cs_test_pending",
    status: input.checkoutStatus || "open",
    payment_status: input.checkoutPaymentStatus ?? "unpaid",
  }] : [];
  let stripeCheckoutStatus = input.stripeCheckoutStatus || "open";
  let pixPending = Boolean(input.pendingPix);

  const merlin_db = { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first<T>() {
        if (sql.includes("provider = 'mercadopago'")) return (pixPending ? { id: 12 } : null) as T | null;
        return null;
      },
      async all<T>() {
        if (sql.includes("provider = 'stripe'") && sql.includes("reactivation_license_id")) {
          return { results: checkouts as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("UPDATE checkout_sessions") && sql.includes("status = 'expired'")) {
          const checkout = checkouts.find((row) => row.id === Number(args[1]));
          if (checkout && checkout.status === "open" && checkout.payment_status !== "paid") {
            checkout.status = "expired";
            checkout.payment_status = "expired";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  } };
  const c = { env: {
    STRIPE_SECRET_KEY: input.stripeKey === undefined ? "sk_test_fake" : input.stripeKey,
    merlin_db,
  } } as unknown as AppContext;

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const method = init?.method || "GET";
    calls.push({ method, path: `${parsed.pathname}${parsed.search}` });

    if (parsed.pathname.endsWith("/subscriptions/sub_test")) {
      return new Response(JSON.stringify({ id: "sub_test", customer: input.customer || "cus_test",
        status: input.subscriptionStatus || "canceled",
        ended_at: input.endedAt === undefined ? Date.parse(expiry) / 1000 + 1 : input.endedAt }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/checkout/sessions/cs_test_pending/expire")) {
      if (input.expireRace) {
        stripeCheckoutStatus = input.expireRace;
        return new Response(JSON.stringify({ error: { message: "Checkout state changed" } }), { status: 400 });
      }
      if (input.expireFails) {
        return new Response(JSON.stringify({ error: { message: "Cannot expire" } }), { status: 400 });
      }
      stripeCheckoutStatus = "expired";
      return new Response(JSON.stringify({ id: "cs_test_pending", status: "expired", payment_status: "unpaid" }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/checkout/sessions/cs_test_pending")) {
      return new Response(JSON.stringify({ id: "cs_test_pending", status: stripeCheckoutStatus,
        payment_status: stripeCheckoutStatus === "complete" ? "paid" : "unpaid" }), { status: 200 });
    }
    const status = parsed.searchParams.get("status");
    return new Response(JSON.stringify({ data: status === "open" && input.openInvoice
      || status === "draft" && input.draftInvoice ? [{ id: "in_pending" }] : [] }), { status: 200 });
  }));
  return { c, calls, checkouts };
}

describe("expired card to Pix safety gate", () => {
  test("accepts an ended subscription without pending checkout or invoice", async () => {
    const { c, calls } = setup();
    await expect(assertExpiredCardToPixReady(c, license)).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(calls[0].path).toContain("/subscriptions/sub_test");
    expect(calls[1].path).toContain("status=open");
    expect(calls[2].path).toContain("status=draft");
  });

  test("expires an abandoned open Stripe renewal before allowing Pix", async () => {
    const { c, calls, checkouts } = setup({ pendingCheckout: true });
    await expect(assertExpiredCardToPixReady(c, license)).resolves.toBeUndefined();
    expect(calls.slice(0, 2)).toEqual([
      { method: "GET", path: "/v1/checkout/sessions/cs_test_pending" },
      { method: "POST", path: "/v1/checkout/sessions/cs_test_pending/expire" },
    ]);
    expect(checkouts[0]).toMatchObject({ status: "expired", payment_status: "expired" });
    expect(calls).toHaveLength(5);
  });

  test("synchronizes an already-expired Stripe session and allows Pix", async () => {
    const { c, checkouts } = setup({ pendingCheckout: true, stripeCheckoutStatus: "expired" });
    await expect(assertExpiredCardToPixReady(c, license)).resolves.toBeUndefined();
    expect(checkouts[0]).toMatchObject({ status: "expired", payment_status: "expired" });
  });

  test("reconciles a checkout that completed before Pix was selected, then blocks Pix", async () => {
    const { c, calls, checkouts } = setup({ pendingCheckout: true, stripeCheckoutStatus: "complete" });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/foi concluida ou esta sendo confirmada/);
    expect(reconcileStripeCheckoutSession).toHaveBeenCalledWith(c, "cs_test_pending");
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/expire"))).toBe(false);
    expect(checkouts[0].status).toBe("open");
  });

  test("does not expire an open provider session when local payment is already settled", async () => {
    const { c, calls, checkouts } = setup({ pendingCheckout: true, checkoutPaymentStatus: "paid" });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/precisa ser conciliado/);
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/expire"))).toBe(false);
    expect(checkouts[0].status).toBe("open");
  });

  test("handles the race where payment completes while Stripe expires the checkout", async () => {
    const { c, calls } = setup({ pendingCheckout: true, expireRace: "complete" });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/foi concluida ou esta sendo confirmada/);
    expect(reconcileStripeCheckoutSession).toHaveBeenCalledWith(c, "cs_test_pending");
    expect(calls.filter((call) => call.path.endsWith("/checkout/sessions/cs_test_pending"))).toHaveLength(2);
  });

  test("fails closed when Stripe cannot expire an open checkout", async () => {
    const { c, checkouts } = setup({ pendingCheckout: true, expireFails: true });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/Nao foi possivel confirmar o encerramento/);
    expect(checkouts[0].status).toBe("open");
  });

  test("does not free a locally paid checkout even if Stripe says expired", async () => {
    const { c, checkouts } = setup({ pendingCheckout: true, checkoutPaymentStatus: "paid", stripeCheckoutStatus: "expired" });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/precisa ser conciliado/);
    expect(checkouts[0].status).toBe("open");
  });

  test("does not clear an unlinked checkout reservation", async () => {
    const { c, calls } = setup({ pendingCheckout: true });
    const row = calls;
    // Simulate the DB reservation before Stripe has returned a hosted session ID.
    const prepare = c.env.merlin_db.prepare;
    c.env.merlin_db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("provider = 'stripe'") && sql.includes("reactivation_license_id")) {
        return { ...statement, all: async () => ({ results: [{ id: 9, provider_session_id: "pending_checkout_9", status: "open", payment_status: "unpaid" }] }) };
      }
      return statement;
    }) as typeof c.env.merlin_db.prepare;
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/ainda esta sendo criada/);
    expect(row).toHaveLength(0);
  });

  test("an earlier immediate cancellation still waits for the Merlin license expiry", async () => {
    const { c } = setup({ endedAt: Date.parse(expiry) / 1000 - 3600 });
    await expect(assertExpiredCardToPixReady(c, license)).resolves.toBeUndefined();
    await expect(assertExpiredCardToPixReady(c, { ...license,
      expires_at: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/ainda nao terminou/);
  });

  test.each([
    { name: "subscription still active", input: { subscriptionStatus: "active" } },
    { name: "subscription end is in the future", input: { endedAt: Date.now() / 1000 + 3600 } },
    { name: "different Stripe customer", input: { customer: "cus_other" } },
  ])("rejects $name", async ({ input }) => {
    const { c, calls } = setup(input);
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/renovacao automatica/);
    expect(calls).toHaveLength(1);
  });

  test.each([
    { name: "open", input: { openInvoice: true } },
    { name: "draft", input: { draftInvoice: true } },
  ])("rejects an $name card invoice", async ({ input }) => {
    const { c } = setup(input);
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/fatura do cartao pendente/);
  });

  test("fails closed when Stripe cannot be checked", async () => {
    const { c, calls } = setup({ stripeKey: "" });
    await expect(assertExpiredCardToPixReady(c, license)).rejects.toThrow(/Stripe indisponivel/);
    expect(calls).toHaveLength(0);
  });

  test("prevents opening a card checkout while a Pix reactivation is pending", async () => {
    const { c } = setup({ pendingPix: true });
    await expect(assertNoPendingPixReactivation(c, 7)).rejects.toThrow(/Pix em andamento/);
  });
});
