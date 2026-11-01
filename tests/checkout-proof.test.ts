import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { setCheckoutProof } from "../src/lib/checkout-proof";
import { getPublicCheckoutStatus } from "../src/lib/stripe-webhook";
import type { AppBindings } from "../src/types";
import worker from "../src/index";

describe("checkout license disclosure", () => {
  it("routes Stripe webhooks on the public host to signature validation", async () => {
    const env = { ENVIRONMENT: "staging", ADMIN_APP_HOST: "admin-staging.api-merlin.com", SESSION_HASH_SECRET: "test" } as unknown as AppBindings;
    const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    for (const path of ["/payment/webhooks/stripe", "/api/stripe/webhook"]) {
      const response = await worker.fetch(new Request(`https://staging.api-merlin.com${path}`, { method: "POST", body: "{}" }), env, execution);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Assinatura Stripe");
    }
  });
  it("requires proof from the browser that opened this checkout", async () => {
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() {
            if (sql.includes("FROM checkout_sessions")) return {
              provider_session_id: args[1], status: "complete", payment_status: "paid", license_id: 1,
            };
            if (sql.includes("FROM licenses")) return {
              id: 1, license_key: "TEST-LICENSE-SECRET", name: "Test", expires_at: "2099-01-01", status: "active",
            };
            return null;
          },
        };
      },
    };
    const app = new Hono<{ Bindings: AppBindings }>();
    app.post("/create/:id", async c => { await setCheckoutProof(c, c.req.param("id")); return c.json({ ok: true }); });
    app.get("/status/:id", async c => c.json(await getPublicCheckoutStatus(c, c.req.param("id"))));
    const env = { SESSION_HASH_SECRET: "test-secret", merlin_db: db } as unknown as AppBindings;
    const created = await app.request("https://example.com/create/cs_test_1", { method: "POST" }, env);
    const cookie = created.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const status = (id: string, proof?: string) => app.request(`https://example.com/status/${id}`, { headers: proof ? { cookie: proof } : {} }, env);
    expect(await (await status("cs_test_1")).json()).toMatchObject({ status: "completed", verificationRequired: true });
    expect(await (await status("cs_test_1", cookie)).json()).toMatchObject({ license: { licenseKey: "TEST-LICENSE-SECRET" } });
    expect(await (await status("cs_test_2", cookie)).json()).toMatchObject({ verificationRequired: true });
    expect(await (await status("cs_test_1", cookie.replace(/([a-f0-9])(?=;)/, "x"))).json()).toMatchObject({ verificationRequired: true });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      expect(await (await status("cs_test_1", cookie)).json()).toMatchObject({ verificationRequired: true });
    } finally { vi.useRealTimers(); }
  });
});
