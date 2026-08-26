import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  cancelScheduledSubscriptionPlanChange,
  createSubscriptionPlanChange,
  markPlanChangePaymentProblem,
  previewImmediatePlanChangeCharge,
  markSubscriptionScheduleEvent,
  previewSubscriptionPlanChange,
  syncInvoicePlanChangeFromStripe,
  syncSubscriptionPlanFromStripe,
  listPublicBillingPlanPrices,
  mirrorMonthlyPixPlanPrices,
} from "../src/lib/subscription-plan-change";

type Row = Record<string, any>;

class FakeStatement {
  private values: any[] = [];

  constructor(private db: FakeD1Database, private sql: string) {}

  bind(...values: any[]) {
    this.values = values;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.db.query(this.sql, this.values)[0] as T | null);
  }

  all<T>() {
    return Promise.resolve({ results: this.db.query(this.sql, this.values) as T[] });
  }

  run() {
    const meta = this.db.run(this.sql, this.values);
    return Promise.resolve({ meta });
  }
}

class FakeD1Database {
  prices: Row[] = [];
  licenses: Row[] = [];
  changes: Row[] = [];
  nextChangeId = 1;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  query(sql: string, values: any[]) {
    const normalized = compact(sql);
    if (normalized.includes("FROM subscription_plan_changes") && normalized.includes("status IN ('canceled', 'released')")) {
      return this.changes
        .filter((change) => change.license_id === values[0] && ["canceled", "released"].includes(change.status))
        .sort((a, b) => b.id - a.id)
        .slice(0, 1);
    }
    if (normalized.includes("FROM licenses") && normalized.includes("WHERE id = ?")) {
      return this.licenses.filter((license) => license.id === values[0]).slice(0, 1);
    }
    if (normalized.includes("FROM billing_plan_prices") && normalized.includes("payment_method = ?") && normalized.includes("plan_tier = ?")) {
      const [, method, tier, period] = values;
      return this.prices.filter((price) => (
        price.provider === "stripe"
        && price.payment_method === method
        && price.plan_tier === tier
        && price.billing_period === period
      )).slice(0, 1);
    }
    if (normalized.includes("FROM billing_plan_prices") && normalized.includes("ORDER BY payment_method")) {
      return this.prices.filter((price) => price.provider === values[0]);
    }
    if (normalized.includes("FROM billing_plan_prices") && normalized.includes("provider_price_id = ?")) {
      const [, priceId] = values;
      return this.prices.filter((price) => (
        price.provider === "stripe"
        && price.payment_method === "card"
        && price.provider_price_id === priceId
        && price.active === 1
      )).slice(0, 1);
    }
    if (normalized.includes("FROM subscription_plan_changes") && normalized.includes("license_id = ?")) {
      return this.changes
        .filter((change) => change.license_id === values[0] && ["pending_payment", "payment_action_required", "scheduled"].includes(change.status))
        .sort((a, b) => b.id - a.id)
        .slice(0, 1);
    }
    if (normalized.includes("FROM subscription_plan_changes") && normalized.includes("stripe_subscription_id = ?")) {
      const [subscriptionId, targetPriceId] = values;
      return this.changes
        .filter((change) => (
          change.stripe_subscription_id === subscriptionId
          && change.target_price_id === targetPriceId
          && ["pending_payment", "payment_action_required", "scheduled"].includes(change.status)
        ))
        .sort((a, b) => b.id - a.id)
        .slice(0, 1);
    }
    return [];
  }

  run(sql: string, values: any[]) {
    const normalized = compact(sql);
    if (normalized.startsWith("INSERT INTO subscription_plan_changes")) {
      const id = this.nextChangeId++;
      this.changes.push({
        id,
        license_id: values[0],
        customer_id: values[1],
        provider: values[2],
        stripe_customer_id: values[3],
        stripe_subscription_id: values[4],
        stripe_subscription_item_id: values[5],
        stripe_schedule_id: values[6],
        stripe_invoice_id: values[7],
        stripe_payment_intent_id: values[8],
        current_plan_tier: values[9],
        target_plan_tier: values[10],
        current_billing_period: values[11],
        target_billing_period: values[12],
        current_price_id: values[13],
        target_price_id: values[14],
        change_type: values[15],
        timing: values[16],
        status: values[17],
        requested_at: values[18],
        effective_at: values[19],
        raw_json: values[20],
        created_at: values[21],
        updated_at: values[22],
      });
      return { last_row_id: id, changes: 1 };
    }
    if (normalized.startsWith("UPDATE licenses SET plan_tier = ?")) {
      const [targetTier, accessType, periodStart, periodEnd, , subscriptionId] = values;
      for (const license of this.licenses.filter((item) => item.stripe_subscription_id === subscriptionId)) {
        license.plan_tier = targetTier;
        license.access_type = accessType;
        license.billing_status = "active";
        license.billing_current_period_start = periodStart || license.billing_current_period_start;
        license.billing_current_period_end = periodEnd || license.billing_current_period_end;
      }
      return { changes: 1 };
    }
    if (normalized.startsWith("UPDATE subscription_plan_changes SET status = 'applied'")) {
      const [appliedAt, updatedAt, subscriptionId, targetPriceId] = values;
      for (const change of this.changes.filter((item) => (
        item.stripe_subscription_id === subscriptionId
        && item.target_price_id === targetPriceId
        && ["pending_payment", "payment_action_required", "scheduled"].includes(item.status)
      ))) {
        change.status = "applied";
        change.applied_at ||= appliedAt;
        change.updated_at = updatedAt;
      }
      return { changes: 1 };
    }
    if (normalized.startsWith("UPDATE subscription_plan_changes SET status = ?")) {
      const [status, updatedAt, reason, subscriptionId] = values;
      for (const change of this.changes.filter((item) => item.stripe_subscription_id === subscriptionId && item.status === "pending_payment")) {
        change.status = status;
        change.updated_at = updatedAt;
        change.failure_reason ||= reason;
      }
      return { changes: 1 };
    }
    if (normalized.startsWith("UPDATE subscription_plan_changes SET status = CASE")) {
      const [nextStatus, statusCheck, canceledAt, updatedAt, scheduleId] = values;
      for (const change of this.changes.filter((item) => item.stripe_schedule_id === scheduleId)) {
        if (change.status !== "applied") change.status = nextStatus;
        if (statusCheck === "canceled") change.canceled_at ||= canceledAt;
        change.updated_at = updatedAt;
      }
      return { changes: 1 };
    }
    if (normalized.startsWith("UPDATE subscription_plan_changes SET status = 'released'")) {
      const [canceledAt, updatedAt, id] = values;
      for (const change of this.changes.filter((item) => item.id === id && item.status === "scheduled")) {
        change.status = "released";
        change.canceled_at ||= canceledAt;
        change.updated_at = updatedAt;
      }
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function createContext(db: FakeD1Database) {
  return {
    env: {
      merlin_db: db,
      STRIPE_SECRET_KEY: "sk_test_fake",
    },
  } as any;
}

function seedDb(overrides: Partial<Row> = {}) {
  const db = new FakeD1Database();
  db.prices = [
    price("bronze", "monthly", "price_bronze_monthly", 1490),
    price("prata", "monthly", "price_prata_monthly", 1990),
    price("ouro", "monthly", "price_ouro_monthly", 2490),
    price("bronze", "annual", "price_bronze_annual", 11990),
    price("prata", "annual", "price_prata_annual", 15990),
    price("ouro", "annual", "price_ouro_annual", 19990),
    price("bronze", "monthly", null, 1490, "pix"),
    price("prata", "monthly", null, 1990, "pix"),
    price("ouro", "monthly", null, 2490, "pix"),
    price("bronze", "annual", null, 11990, "pix"),
    price("prata", "annual", null, 15990, "pix"),
    price("ouro", "annual", null, 19990, "pix"),
  ];
  db.licenses = [{
    id: 1,
    customer_id: 10,
    stripe_customer_id: "cus_123",
    stripe_subscription_id: "sub_123",
    stripe_subscription_item_id: null,
    plan_tier: "bronze",
    access_type: "monthly_subscription",
    billing_status: "active",
    billing_current_period_start: "2026-08-01T00:00:00.000Z",
    billing_current_period_end: "2026-09-01T00:00:00.000Z",
    billing_cancel_at_period_end: 0,
    status: "active",
    ...overrides,
  }];
  return db;
}

function price(tier: string, period: string, priceId: string | null, amountCents: number, method = "card") {
  return {
    provider: "stripe",
    payment_method: method,
    plan_tier: tier,
    billing_period: period,
    provider_price_id: priceId,
    amount_cents: amountCents,
    currency: "brl",
    active: 1,
  };
}

function stripeSubscription(priceId = "price_bronze_monthly", options: { topLevelPeriod?: boolean; periodStart?: number; periodEnd?: number } = {}) {
  const topLevelPeriod = options.topLevelPeriod ?? true;
  const periodStart = options.periodStart ?? 1785542400;
  const periodEnd = options.periodEnd ?? 1788220800;
  return {
    id: "sub_123",
    status: "active",
    ...(topLevelPeriod ? { current_period_start: periodStart, current_period_end: periodEnd } : {}),
    cancel_at_period_end: false,
    items: {
      data: [{
        id: "si_123",
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        price: { id: priceId, recurring: { interval: priceId.includes("annual") ? "year" : "month" } },
      }],
    },
  };
}

function mockStripe(input: { subscriptionPriceId?: string; updatedPriceId?: string; invoicePaid?: boolean; topLevelPeriod?: boolean; subscriptionStatus?: string; invoiceAmountCents?: number; periodStart?: number; periodEnd?: number } = {}) {
  const calls: Array<{ url: string; body: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body || ""), method: init.method || "GET" });
    if (url.includes("/subscriptions/sub_123") && init.method === "GET") {
      return jsonResponse({
        ...stripeSubscription(input.subscriptionPriceId || input.updatedPriceId || "price_bronze_monthly", { topLevelPeriod: input.topLevelPeriod, periodStart: input.periodStart, periodEnd: input.periodEnd }),
        status: input.subscriptionStatus || "active",
        ...(input.subscriptionStatus === "trialing" ? { trial_end: 1788220800 } : {}),
      });
    }
    if (url.endsWith("/invoices/create_preview") && init.method === "POST") {
      return jsonResponse({ amount_due: input.invoiceAmountCents ?? 19990, total: input.invoiceAmountCents ?? 19990 });
    }
    if (url.includes("/subscriptions/sub_123") && init.method === "POST") {
      const body = new URLSearchParams(String(init.body || ""));
      const targetPriceId = body.get("items[0][price]") || input.updatedPriceId || "price_prata_monthly";
      return jsonResponse({
        ...stripeSubscription(targetPriceId, { topLevelPeriod: input.topLevelPeriod, periodStart: input.periodStart, periodEnd: input.periodEnd }),
        latest_invoice: {
          id: "in_123",
          status: input.invoicePaid ? "paid" : "open",
          paid: Boolean(input.invoicePaid),
          payment_intent: { id: "pi_123" },
        },
      });
    }
    if (url.endsWith("/subscription_schedules") && init.method === "POST") {
      return jsonResponse({ id: "sched_123" });
    }
    if (url.includes("/subscription_schedules/sched_123") && init.method === "POST") {
      return jsonResponse({ id: "sched_123" });
    }
    return jsonResponse({});
  }));
  return calls;
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("subscription plan changes", () => {
  test("monthly Pix mirrors card price without changing annual Pix", () => {
    const prices = mirrorMonthlyPixPlanPrices([
      { paymentMethod: "card", planTier: "bronze", billingPeriod: "monthly", amountCents: 1490, currency: "brl", active: true },
      { paymentMethod: "pix", planTier: "bronze", billingPeriod: "monthly", amountCents: 999, currency: "usd", active: false },
      { paymentMethod: "pix", planTier: "bronze", billingPeriod: "annual", amountCents: 10990, currency: "brl", active: true },
    ]);

    expect(prices[1]).toMatchObject({ amountCents: 1490, currency: "brl", active: true });
    expect(prices[2]).toMatchObject({ amountCents: 10990, currency: "brl", active: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("previews upgrade, downgrade and interval-change timing", async () => {
    const db = seedDb({ plan_tier: "bronze", access_type: "monthly_subscription" });
    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" }))
      .resolves.toMatchObject({ changeType: "upgrade", timing: "immediate", requiresPaymentConfirmation: true });

    db.licenses[0].plan_tier = "ouro";
    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" }))
      .resolves.toMatchObject({ changeType: "downgrade", timing: "period_end", requiresPaymentConfirmation: false });

    db.licenses[0].plan_tier = "prata";
    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "annual" }))
      .resolves.toMatchObject({ changeType: "interval_change", timing: "immediate" });

    db.licenses[0].access_type = "annual_subscription";
    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" }))
      .resolves.toMatchObject({ changeType: "interval_change", timing: "period_end" });

    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "ouro", targetPeriod: "monthly" }))
      .resolves.toMatchObject({ changeType: "upgrade", timing: "period_end", requiresPaymentConfirmation: false });
  });

  test("does not allow a canceled Stripe subscription to start another plan change", async () => {
    const db = seedDb({ billing_status: "canceled" });

    await expect(previewSubscriptionPlanChange(createContext(db), {
      licenseId: 1,
      targetTier: "prata",
      targetPeriod: "monthly",
    })).rejects.toThrow("Esta assinatura foi cancelada");
  });

  test("ends a trial in the Stripe invoice preview for an immediate plan change", async () => {
    const db = seedDb();
    const stripeCalls = mockStripe({ subscriptionStatus: "trialing" });

    await expect(previewImmediatePlanChangeCharge(createContext(db), {
      licenseId: 1,
      targetPriceId: "price_ouro_annual",
      targetAmountCents: 19990,
    })).resolves.toMatchObject({ amountDueNowCents: 19990 });

    const previewCall = stripeCalls.find((call) => call.url.endsWith("/invoices/create_preview"));
    expect(previewCall?.body).toContain("subscription_details%5Btrial_end%5D=now");
  });

  test("keeps Stripe's prorated amount for an active subscription", async () => {
    const db = seedDb();
    const stripeCalls = mockStripe({ invoiceAmountCents: 17501 });

    await expect(previewImmediatePlanChangeCharge(createContext(db), {
      licenseId: 1,
      targetPriceId: "price_ouro_annual",
      targetAmountCents: 19990,
    })).resolves.toMatchObject({ amountDueNowCents: 17501 });

    const previewCall = stripeCalls.find((call) => call.url.endsWith("/invoices/create_preview"));
    expect(previewCall?.body).not.toContain("subscription_details%5Btrial_end%5D=now");
    expect(previewCall?.body).toContain("subscription_details%5Bbilling_cycle_anchor%5D=now");
  });

  test("does not send a proration date when the portal resets the billing anchor", async () => {
    const db = seedDb();
    const stripeCalls = mockStripe({ periodStart: 2_000_000_000, periodEnd: 2_000_100_000 });

    await previewImmediatePlanChangeCharge(createContext(db), {
      licenseId: 1,
      targetPriceId: "price_ouro_annual",
      targetAmountCents: 19990,
    });

    const previewCall = stripeCalls.find((call) => call.url.endsWith("/invoices/create_preview"));
    expect(previewCall?.body).toContain("subscription_details%5Bbilling_cycle_anchor%5D=now");
    expect(previewCall?.body).not.toContain("subscription_details%5Bproration_date%5D");
  });

  test("lists public tier prices without exposing Stripe price IDs", async () => {
    const db = seedDb();
    const prices = await listPublicBillingPlanPrices(createContext(db));

    expect(prices).toHaveLength(12);
    expect(prices).toContainEqual({
      paymentMethod: "card",
      planTier: "bronze",
      billingPeriod: "monthly",
      amountCents: 1490,
      currency: "brl",
      active: true,
    });
    expect(prices).toContainEqual({
      paymentMethod: "pix",
      planTier: "ouro",
      billingPeriod: "annual",
      amountCents: 19990,
      currency: "brl",
      active: true,
    });
    expect(prices.some((item) => "priceId" in item)).toBe(false);
  });

  test("rejects same plan, manual Pix licenses, canceling subscriptions and missing price IDs", async () => {
    await expect(previewSubscriptionPlanChange(createContext(seedDb({ plan_tier: "bronze" })), { licenseId: 1, targetTier: "bronze", targetPeriod: "monthly" }))
      .rejects.toThrow("A licenca ja esta neste plano.");

    await expect(previewSubscriptionPlanChange(createContext(seedDb({ stripe_customer_id: null, stripe_subscription_id: null, access_type: "annual_manual" })), { licenseId: 1, targetTier: "prata", targetPeriod: "annual" }))
      .rejects.toThrow("Esta licenca nao possui assinatura Stripe");

    await expect(previewSubscriptionPlanChange(createContext(seedDb({ billing_cancel_at_period_end: 1 })), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" }))
      .rejects.toThrow("Remova o cancelamento agendado");

    const db = seedDb();
    db.prices = db.prices.map((item) => item.provider_price_id === "price_prata_monthly" ? { ...item, provider_price_id: null } : item);
    await expect(previewSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" }))
      .rejects.toThrow("Price ID do plano de destino");
  });

  test("creates pending upgrade without releasing the target tier before payment", async () => {
    const db = seedDb({ plan_tier: "bronze", access_type: "monthly_subscription" });
    const stripeCalls = mockStripe({ subscriptionPriceId: "price_bronze_monthly", invoicePaid: false });

    const result = await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    expect(result).toMatchObject({ status: "pending_payment", timing: "immediate", changeType: "upgrade" });
    expect(db.licenses[0].plan_tier).toBe("bronze");
    expect(db.changes[0]).toMatchObject({
      status: "pending_payment",
      target_plan_tier: "prata",
      target_price_id: "price_prata_monthly",
      stripe_invoice_id: "in_123",
      stripe_payment_intent_id: "pi_123",
    });
    expect(stripeCalls.some((call) => call.body.includes("payment_behavior=pending_if_incomplete"))).toBe(true);
  });

  test("applies immediate upgrade only after invoice payment is confirmed", async () => {
    const db = seedDb({ plan_tier: "bronze", access_type: "monthly_subscription" });
    mockStripe({ subscriptionPriceId: "price_bronze_monthly", invoicePaid: false });
    await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    mockStripe({ subscriptionPriceId: "price_prata_monthly" });
    await syncInvoicePlanChangeFromStripe(createContext(db), {
      id: "in_123",
      status: "paid",
      paid: true,
      subscription: "sub_123",
    });

    expect(db.licenses[0]).toMatchObject({
      plan_tier: "prata",
      access_type: "monthly_subscription",
      billing_status: "active",
    });
    expect(db.changes[0].status).toBe("applied");
  });

  test("marks pending upgrade payment problems without releasing the target tier", async () => {
    const db = seedDb({ plan_tier: "bronze" });
    mockStripe({ invoicePaid: false });
    await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    await markPlanChangePaymentProblem(createContext(db), { subscription: "sub_123" }, "payment_failed");

    expect(db.licenses[0].plan_tier).toBe("bronze");
    expect(db.changes[0]).toMatchObject({ status: "payment_failed", failure_reason: "payment_failed" });
  });

  test("schedules downgrades for period end and applies them when Stripe moves to the target price", async () => {
    const db = seedDb({ plan_tier: "ouro", access_type: "monthly_subscription" });
    mockStripe({ subscriptionPriceId: "price_ouro_monthly" });

    const result = await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    expect(result).toMatchObject({ status: "scheduled", timing: "period_end", changeType: "downgrade", scheduleId: "sched_123" });
    expect(db.licenses[0].plan_tier).toBe("ouro");
    expect(db.changes[0]).toMatchObject({ status: "scheduled", stripe_schedule_id: "sched_123" });

    await syncSubscriptionPlanFromStripe(createContext(db), stripeSubscription("price_prata_monthly"), { paymentConfirmed: false });

    expect(db.licenses[0].plan_tier).toBe("ouro");
    expect(db.changes[0].status).toBe("scheduled");

    await syncSubscriptionPlanFromStripe(createContext(db), stripeSubscription("price_prata_monthly", {
      periodStart: 1788220800,
      periodEnd: 1819756800,
    }), { paymentConfirmed: false });

    expect(db.licenses[0].plan_tier).toBe("prata");
    expect(db.changes[0].status).toBe("applied");
  });

  test("uses the subscription item period when Stripe omits top-level period fields", async () => {
    const db = seedDb({ plan_tier: "ouro", access_type: "annual_subscription", billing_current_period_start: null });
    const stripeCalls = mockStripe({ subscriptionPriceId: "price_ouro_annual", topLevelPeriod: false });

    const result = await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "ouro", targetPeriod: "monthly" });

    expect(result).toMatchObject({ status: "scheduled", timing: "period_end", changeType: "interval_change", scheduleId: "sched_123" });
    const scheduleUpdate = stripeCalls.find((call) => call.url.includes("/subscription_schedules/sched_123"));
    expect(scheduleUpdate?.body).toContain("phases%5B0%5D%5Bstart_date%5D=1785542400");
    expect(scheduleUpdate?.body).toContain("phases%5B0%5D%5Bend_date%5D=1788220800");
    expect(scheduleUpdate?.body).toContain("phases%5B1%5D%5Bbilling_cycle_anchor%5D=phase_start");
  });

  test("uses a new Stripe idempotency scope after a canceled schedule", async () => {
    const db = seedDb({ plan_tier: "ouro", access_type: "annual_subscription" });
    db.changes.push({ id: 8, license_id: 1, status: "canceled" });
    const stripeCalls = mockStripe({ subscriptionPriceId: "price_ouro_annual" });

    await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "ouro", targetPeriod: "monthly" });

    const scheduleCreate = stripeCalls.find((call) => call.url.endsWith("/subscription_schedules"));
    expect((vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/subscription_schedules"))?.[1] as RequestInit)?.headers)
      .toMatchObject({ "Idempotency-Key": "merlin_schedule_from:sub_123:retry:8" });
    expect(scheduleCreate?.method).toBe("POST");
  });

  test("canceled schedules mark scheduled plan changes as canceled", async () => {
    const db = seedDb({ plan_tier: "ouro" });
    mockStripe({ subscriptionPriceId: "price_ouro_monthly" });
    await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    await markSubscriptionScheduleEvent(createContext(db), { id: "sched_123" }, "canceled");

    expect(db.changes[0].status).toBe("canceled");
    expect(db.changes[0].canceled_at).toBeTruthy();
  });

  test("releases a scheduled change without canceling its Stripe subscription", async () => {
    const db = seedDb({ plan_tier: "ouro" });
    const stripeCalls = mockStripe({ subscriptionPriceId: "price_ouro_monthly" });
    await createSubscriptionPlanChange(createContext(db), { licenseId: 1, targetTier: "prata", targetPeriod: "monthly" });

    await cancelScheduledSubscriptionPlanChange(createContext(db), 1);

    expect(stripeCalls.some((call) => call.url.includes("/subscription_schedules/sched_123/release"))).toBe(true);
    expect(db.changes[0].status).toBe("released");
  });
});
