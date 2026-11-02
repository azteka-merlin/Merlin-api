import { describe, expect, it } from "vitest";
import { capturePaidSubscriberSnapshot, classifyPayer, summarizeFinance, summarizePaidPeriodDistribution, TIER_RECEIPTS_SQL, type FinanceLicenseRow } from "./admin-finance-dashboard";
import { DatabaseSync } from "node:sqlite";
import type { AppBindings } from "../types";

const now = new Date("2026-10-28T12:00:00.000Z");

function license(id: number, patch: Partial<FinanceLicenseRow> = {}): FinanceLicenseRow {
  return {
    id,
    name: `Licença ${id}`,
    source: "mercadopago_pix",
    access_type: "monthly_subscription",
    billing_status: "active",
    plan_tier: "bronze",
    expires_at: "2026-11-10T12:00:00.000Z",
    billing_current_period_end: "2026-11-10T12:00:00.000Z",
    billing_cancel_at_period_end: 1,
    stripe_subscription_id: null,
    has_confirmed_payment: 1,
    ...patch,
  };
}

const prices = [
  { payment_method: "pix", billing_period: "monthly", plan_tier: "bronze", amount_cents: 1490 },
  { payment_method: "card", billing_period: "monthly", plan_tier: "bronze", amount_cents: 1490 },
  { payment_method: "pix", billing_period: "semiannual", plan_tier: "bronze", amount_cents: 6590 },
  { payment_method: "card", billing_period: "semiannual", plan_tier: "bronze", amount_cents: 6590 },
  { payment_method: "pix", billing_period: "annual", plan_tier: "ouro", amount_cents: 19990 },
  { payment_method: "card", billing_period: "annual", plan_tier: "ouro", amount_cents: 19990 },
];

describe("admin finance dashboard", () => {
  it("records daily paid subscribers and excludes free, tests, expired and lifetime licenses", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE paid_subscriber_daily_snapshots(day TEXT,tier TEXT,subscribers INTEGER,sampled_at TEXT,PRIMARY KEY(day,tier));
      CREATE TABLE licenses(id INTEGER,plan_tier TEXT,status TEXT,expires_at TEXT,license_type TEXT,billing_status TEXT,access_type TEXT,stripe_subscription_id TEXT,source TEXT);
      CREATE TABLE payments(license_id INTEGER,status TEXT,amount_cents INTEGER,currency TEXT);
      INSERT INTO licenses VALUES
      (1,'bronze','active','2026-12-01','normal','active','monthly_manual',NULL,'mercadopago_pix'),
      (2,'ouro','active','2026-12-01','normal','active','annual_subscription','sub_2','stripe'),
      (3,'bronze','active','2026-12-01','normal','active','free',NULL,'mercadopago_pix'),
      (4,'prata','active','2026-12-01','test','active','monthly_manual',NULL,'mercadopago_pix'),
      (5,'prata','active','2026-10-01','normal','active','monthly_manual',NULL,'mercadopago_pix'),
      (6,'ouro','active','2026-12-01','normal','active','paid_lifetime',NULL,'stripe'),
      (7,'prata','active','2026-12-01','normal','active','monthly_manual',NULL,'mercadopago_pix');
      INSERT INTO payments VALUES(1,'paid',1490,'brl'),(2,'paid',5000,'brl'),(3,'paid',100,'brl'),(4,'paid',100,'brl'),(5,'paid',100,'brl'),(6,'paid',100,'brl'),(7,'paid',0,'brl');`);
    const env = { merlin_db: { prepare: (sql: string) => ({ bind: (...values: string[]) => ({ run: async () => db.prepare(sql).run(...values) }) }) } } as unknown as AppBindings;
    await capturePaidSubscriberSnapshot(env, new Date('2026-11-02T01:00:00Z'));
    const rows = db.prepare('SELECT day,tier,subscribers FROM paid_subscriber_daily_snapshots ORDER BY tier').all();
    expect(rows).toEqual([{ day: '2026-11-01', tier: 'bronze', subscribers: 1 }, { day: '2026-11-01', tier: 'ouro', subscribers: 1 }, { day: '2026-11-01', tier: 'prata', subscribers: 0 }]);
    await capturePaidSubscriberSnapshot(env, new Date('2026-11-02T01:00:00Z'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM paid_subscriber_daily_snapshots').get()?.count).toBe(3);
    db.close();
  });
  it("attributes paid amounts to checkout tier, excluding tests, free amounts and refunds", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE licenses(id INTEGER,license_type TEXT,plan_tier TEXT);
      CREATE TABLE checkout_sessions(provider TEXT,provider_session_id TEXT,plan_tier TEXT);
      CREATE TABLE payments(provider TEXT,provider_checkout_session_id TEXT,license_id INTEGER,status TEXT,amount_cents INTEGER,currency TEXT,created_at TEXT);
      INSERT INTO licenses VALUES(1,'normal','ouro'),(2,'test','bronze');
      INSERT INTO checkout_sessions VALUES('stripe','s1','bronze'),('stripe','s2','ouro');
      INSERT INTO payments VALUES
        ('stripe','s1',1,'paid',1490,'brl','2026-10-15'),
        ('stripe','s2',1,'paid',2490,'brl','2026-10-16'),
        ('stripe','s1',2,'paid',1490,'brl','2026-10-16'),
        ('stripe','s1',1,'refunded',1490,'brl','2026-10-16'),
        ('stripe','s1',1,'paid',0,'brl','2026-10-16'),
        ('stripe',NULL,1,'paid',500,'brl','2026-10-16'),
        ('stripe','s1',1,'paid',1000,'brl','2026-09-01');`);
    const rows = db.prepare(TIER_RECEIPTS_SQL).all('2026-10-01','2026-11-01');
    expect(rows).toEqual([
      { tier: 'bronze', amount_cents: 1490, payment_count: 1, licenses: 1 },
      { tier: 'ouro', amount_cents: 2490, payment_count: 1, licenses: 1 },
      { tier: 'unknown', amount_cents: 500, payment_count: 1, licenses: 1 },
    ]);
    db.close();
  });
  it("groups retained active payers by confirmed paid periods", () => {
    expect(summarizePaidPeriodDistribution([
      { paid_periods: 1 }, { paid_periods: 2 }, { paid_periods: 3 },
      { paid_periods: 4 }, { paid_periods: 8 }, { paid_periods: 0 },
    ])).toEqual({ onePeriod: 1, twoPeriods: 1, threePeriods: 1, fourOrMorePeriods: 2 });
  });

  it("separates Pix manual from Stripe even though both can use monthly_subscription", () => {
    expect(classifyPayer(license(1))).toBe("pix");
    expect(classifyPayer(license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0 }))).toBe("card_auto");
    expect(classifyPayer(license(3, { source: "stripe", stripe_subscription_id: "sub_3", billing_cancel_at_period_end: 1 }))).toBe("card_ending");
    expect(classifyPayer(license(4, { source: "admin", access_type: "legacy_lifetime", billing_status: "none" }))).toBeNull();
    expect(classifyPayer(license(5, { source: "stripe", access_type: "paid_lifetime", stripe_subscription_id: null }))).toBe("lifetime");
    expect(classifyPayer(license(6, { billing_status: "past_due" }))).toBe("attention");
    expect(classifyPayer(license(7, { source: "stripe", stripe_subscription_id: "sub_trial", has_confirmed_payment: 0 }))).toBe("attention");
  });

  it("projects only due automatic card charges and keeps Pix as a separate opportunity", () => {
    const result = summarizeFinance([
      license(1),
      license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0 }),
      license(3, { source: "stripe", stripe_subscription_id: "sub_3", billing_cancel_at_period_end: 1 }),
      license(4, { source: "stripe", stripe_subscription_id: "sub_4", billing_cancel_at_period_end: 0 }),
      license(5, { source: "stripe", stripe_subscription_id: "sub_5", billing_cancel_at_period_end: 0, plan_tier: "ouro", access_type: "annual_subscription" }),
      license(6, { source: "stripe", access_type: "paid_lifetime", billing_current_period_end: null, expires_at: "9999-12-31T00:00:00.000Z" }),
    ], prices, [
      { provider: "stripe", payment_type: "subscription", plan_type: "monthly", amount_cents: 3000, payment_count: 2 },
      { provider: "mercadopago", payment_type: "one_time", plan_type: "monthly", amount_cents: 1490, payment_count: 1 },
    ], new Set([4]), now);

    expect(result.summary).toMatchObject({
      activeAccess: 6,
      paidActive: 6,
      cardAutomatic: 3,
      cardEnding: 1,
      pixManual: 1,
      paidLifetime: 1,
      receivedCents: 4490,
      receivedCount: 3,
      receivedByPeriod: {
        monthly: { amountCents: 4490, paymentCount: 3 },
        semiannual: { amountCents: 0, paymentCount: 0 },
        annual: { amountCents: 0, paymentCount: 0 },
        lifetime: { amountCents: 0, paymentCount: 0 },
        other: { amountCents: 0, paymentCount: 0 },
      },
      nextCardCents: 21480,
      nextCardCount: 2,
      nextPixPotentialCents: 1490,
      nextPixPotentialCount: 1,
      pendingChangeRenewals: 1,
    });
  });

  it("does not project unknown prices or renewals outside 30 days", () => {
    const result = summarizeFinance([
      license(1, { plan_tier: "prata" }),
      license(2, { source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0, expires_at: "2026-12-10T12:00:00.000Z", billing_current_period_end: "2026-12-10T12:00:00.000Z" }),
    ], prices, [], new Set(), now);
    expect(result.summary.unpricedRenewals).toBe(1);
    expect(result.summary.nextCardCents).toBe(0);
    expect(result.summary.nextPixPotentialCents).toBe(0);
  });

  it("separates receipts and next-30-day estimates by monthly, semiannual and annual plan", () => {
    const result = summarizeFinance([
      license(1),
      license(2, { access_type: "semiannual_subscription", source: "stripe", stripe_subscription_id: "sub_2", billing_cancel_at_period_end: 0 }),
      license(3, { access_type: "annual_manual", plan_tier: "ouro" }),
      license(4, { access_type: "paid_lifetime", source: "stripe", stripe_subscription_id: null, billing_current_period_end: null, expires_at: "9999-12-31T00:00:00.000Z" }),
    ], prices, [
      { provider: "mercadopago", payment_type: "one_time", plan_type: "monthly", amount_cents: 1490, payment_count: 1 },
      { provider: "mercadopago", payment_type: "one_time", plan_type: "semiannual", amount_cents: 6590, payment_count: 1 },
      { provider: "mercadopago", payment_type: "one_time", plan_type: "annual", amount_cents: 19990, payment_count: 1 },
      { provider: "stripe", payment_type: "one_time", plan_type: "lifetime", amount_cents: 15000, payment_count: 1 },
      { provider: "stripe", payment_type: "one_time", plan_type: null, amount_cents: 500, payment_count: 1 },
    ], new Set(), now);

    expect(result.summary.receivedByPeriod).toEqual({
      monthly: { amountCents: 1490, paymentCount: 1 },
      semiannual: { amountCents: 6590, paymentCount: 1 },
      annual: { amountCents: 19990, paymentCount: 1 },
      lifetime: { amountCents: 15000, paymentCount: 1 },
      other: { amountCents: 500, paymentCount: 1 },
    });
    expect(result.summary.nextRenewalsByPeriod).toEqual({
      monthly: { cardCents: 0, cardCount: 0, pixPotentialCents: 1490, pixPotentialCount: 1 },
      semiannual: { cardCents: 6590, cardCount: 1, pixPotentialCents: 0, pixPotentialCount: 0 },
      annual: { cardCents: 0, cardCount: 0, pixPotentialCents: 19990, pixPotentialCount: 1 },
    });
    expect(result.summary.nextCardCents).toBe(6590);
    expect(result.summary.nextPixPotentialCents).toBe(21480);
    expect(result.summary.receivedCents).toBe(43570);
  });
});
