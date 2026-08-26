import { beforeEach, describe, expect, test, vi } from "vitest";
import { createStripeSubscriptionUpdateConfirmPortalSession } from "../src/lib/billing-portal";

class FakeStatement {
  private values: unknown[] = [];

  constructor(private db: FakeD1Database, private sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.db.first(this.sql, this.values) as T | null);
  }

  run() {
    this.db.run(this.sql, this.values);
    return Promise.resolve({ meta: { changes: 1 } });
  }
}

class FakeD1Database {
  configurations = new Map<string, string>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, values: unknown[]) {
    if (sql.includes("FROM stripe_portal_price_configurations")) {
      const configurationId = this.configurations.get(String(values[0]));
      return configurationId ? { stripe_configuration_id: configurationId } : null;
    }
    return null;
  }

  run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT OR IGNORE INTO stripe_portal_price_configurations")) {
      this.configurations.set(String(values[0]), String(values[2]));
    }
  }
}

function context(db: FakeD1Database) {
  return {
    req: { raw: new Request("https://staging.api-merlin.com/api/public/access/session/plan-change") },
    env: { merlin_db: db, STRIPE_SECRET_KEY: "sk_test_fake" },
  } as any;
}

function response(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Stripe plan-change confirmation portal", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("creates and reuses one single-price configuration per target", async () => {
    const db = new FakeD1Database();
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: String(init.body || "") });
      if (url.endsWith("/prices/price_ouro_annual")) {
        return response({ id: "price_ouro_annual", product: "prod_ouro" });
      }
      if (url.endsWith("/billing_portal/configurations")) {
        return response({ id: "bpc_ouro_annual", object: "billing_portal.configuration" });
      }
      if (url.endsWith("/billing_portal/configurations/bpc_ouro_annual")) {
        return response({ id: "bpc_ouro_annual", object: "billing_portal.configuration" });
      }
      if (url.endsWith("/billing_portal/sessions")) {
        return response({ id: "bps_123", object: "billing_portal.session", url: "https://billing.stripe.test/session" });
      }
      return response({});
    }));

    const input = {
      stripeCustomerId: "cus_123",
      subscriptionId: "sub_123",
      subscriptionItemId: "si_123",
      targetPriceId: "price_ouro_annual",
      returnPath: "/meu-acesso?access=plan-change-cancel",
      completedPath: "/meu-acesso?access=plan-change-return",
    };

    await expect(createStripeSubscriptionUpdateConfirmPortalSession(context(db), input))
      .resolves.toEqual({ portalUrl: "https://billing.stripe.test/session" });
    await createStripeSubscriptionUpdateConfirmPortalSession(context(db), input);

    expect(calls.filter((call) => call.url.endsWith("/billing_portal/configurations"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/billing_portal/configurations/bpc_ouro_annual"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/prices/price_ouro_annual"))).toHaveLength(1);
    const configurationCall = calls.find((call) => call.url.endsWith("/billing_portal/configurations"));
    expect(configurationCall?.body).toContain("default_allowed_updates%5D%5B0%5D=price");
    expect(configurationCall?.body).toContain("features%5Bpayment_method_update%5D%5Benabled%5D=true");
    expect(configurationCall?.body).toContain("features%5Bsubscription_update%5D%5Bbilling_cycle_anchor%5D=now");
    const portalSession = calls.filter((call) => call.url.endsWith("/billing_portal/sessions"))[0];
    expect(portalSession.body).toContain("configuration=bpc_ouro_annual");
    expect(portalSession.body).toContain("flow_data%5Bsubscription_update_confirm%5D%5Bitems%5D%5B0%5D%5Bprice%5D=price_ouro_annual");
  });
});
