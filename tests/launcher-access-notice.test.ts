import { describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { signAccessToken } from "../src/lib/auth";

describe("launcher access notice", () => {
  test.each([undefined, 500])("keeps the D1 diagnostic private when the exception status is %s", async (status) => {
    const token = await signAccessToken({
      sub: 42, hwid: "test-device", type: "access", jti: "notice-test",
      exp: Math.floor(Date.now() / 1000) + 60,
    }, "secret");
    const error = Object.assign(new Error("D1_ERROR: Network connection lost. license_key=license-synthetic",
      { cause: new Error("Upstream refused user@example.test at https://provider.test/?token=private (token=synthetic-token)") }),
      { code: "D1_ERROR", status });
    const db = { prepare: () => ({ bind: () => ({ first: async () => { throw error; } }) }) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request("https://api-merlin.com/api/launcher/access-notice?email=user@example.test", {
        headers: { Authorization: `Bearer ${token}`, "cf-ray": "0123456789abcdef-GRU" },
      }), { JWT_SECRET: "secret", merlin_db: db } as any, {} as any);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ success: false, error: "Internal Server Error" });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        event: "merlin_api_error", route: "/api/launcher/access-notice", status: 500, method: "GET",
        rayId: "0123456789abcdef-GRU", errorName: "Error", errorCode: "D1_ERROR",
        errorMessage: "D1_ERROR: Network connection lost. license_key=[redacted]",
        causeMessage: "Upstream refused [redacted] at [url] (token=[redacted])",
        stack: expect.stringContaining("at "),
      }));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/user@example|license-synthetic|provider\.test|synthetic-token|token=private/);
    } finally {
      log.mockRestore();
    }
  });

  test("reports a confirmed Pix renewal for the authenticated license", async () => {
    const license = {
      id: 42,
      license_key: "MERLIN-ABCD-EFGH-JKLM",
      name: "Tester",
      hwid: "device-42",
      expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      status: "active",
      access_type: "monthly_subscription",
      billing_status: "active",
      billing_current_period_end: null,
      billing_cancel_at_period_end: 1,
      stripe_subscription_id: null,
      plan_tier: "bronze",
    };
    let paid = false;
    const queriedIds: number[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(id: number) {
            queriedIds.push(id);
            return {
              async first() {
                if (sql.includes("FROM checkout_sessions")) return paid ? { id: 9 } : null;
                return license;
              },
            };
          },
        };
      },
    };
    const token = await signAccessToken({
      sub: license.id,
      hwid: license.hwid,
      type: "access",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "notice-test",
    }, "secret");
    const request = () => new Request("https://api-merlin.com/api/launcher/access-notice", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const env = { JWT_SECRET: "secret", merlin_db: db } as any;

    let response = await worker.fetch(request(), env, {} as any);
    expect(response.status).toBe(200);
    expect((await response.json() as any).license.billing.renewalScheduled).toBe(false);

    paid = true;
    response = await worker.fetch(request(), env, {} as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json() as any).license.billing.renewalScheduled).toBe(true);
    expect(queriedIds.every((id) => id === license.id)).toBe(true);
  });
});
