import { describe, expect, test } from "vitest";
import { isEligibleForExpiredCardRenewal, isEligibleForExpiredPixRenewal } from "../src/lib/expired-card-renewal";

describe("expired Stripe renewal route", () => {
  test("allows a canceled recurring card license when expiry is represented as active or expired", () => {
    const base = {
      expires_at: "2026-09-03T02:59:59.999Z",
      billing_status: "canceled",
      stripe_customer_id: "cus_test",
      stripe_subscription_id: "sub_test",
      access_type: "monthly_subscription",
    };

    expect(isEligibleForExpiredCardRenewal({ ...base, status: "active" }, new Date("2026-09-18").getTime())).toBe(true);
    expect(isEligibleForExpiredCardRenewal({ ...base, status: "expired" }, new Date("2026-09-18").getTime())).toBe(true);
  });

  test("never allows a revoked, current, or non-canceled card license", () => {
    const base = {
      status: "expired",
      expires_at: "2026-09-03T02:59:59.999Z",
      billing_status: "canceled",
      stripe_customer_id: "cus_test",
      stripe_subscription_id: "sub_test",
      access_type: "monthly_subscription",
    };
    const now = new Date("2026-09-18").getTime();

    expect(isEligibleForExpiredCardRenewal({ ...base, status: "revoked" }, now)).toBe(false);
    expect(isEligibleForExpiredCardRenewal({ ...base, expires_at: "2026-10-18T02:59:59.999Z" }, now)).toBe(false);
    expect(isEligibleForExpiredCardRenewal({ ...base, billing_status: "active" }, now)).toBe(false);
  });

  test("allows an expired Pix renewal with either persisted entitlement status", () => {
    const base = {
      expires_at: "2026-09-03T02:59:59.999Z",
      access_type: "annual_subscription",
    };
    const now = new Date("2026-09-18").getTime();

    expect(isEligibleForExpiredPixRenewal({ ...base, status: "active" }, now)).toBe(true);
    expect(isEligibleForExpiredPixRenewal({ ...base, status: "expired" }, now)).toBe(true);
    expect(isEligibleForExpiredPixRenewal({ ...base, status: "revoked" }, now)).toBe(false);
    expect(isEligibleForExpiredPixRenewal({ ...base, status: "expired", stripe_subscription_id: "sub_test" }, now)).toBe(false);
  });

  test("trusted renewals return to Meu acesso instead of the generic purchase result", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/lib/public-checkout.ts", import.meta.url), "utf8");

    expect(source).toContain("/meu-acesso?access=renewal-return&session_id={CHECKOUT_SESSION_ID}");
    expect(source).toContain("returnToMyAccess: Boolean(trustedRenewal)");
  });
});
