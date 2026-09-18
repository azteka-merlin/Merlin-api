import { describe, expect, test } from "vitest";
import { mapLicense, shouldSyncManualPixBillingPeriod } from "../src/lib/admin-license-service";

describe("manual Pix billing period synchronization", () => {
  test("keeps the displayed period aligned when an admin changes a recurring Pix expiry", () => {
    expect(shouldSyncManualPixBillingPeriod({
      source: "mercadopago_pix",
      access_type: "annual_manual",
      stripe_customer_id: null,
      stripe_subscription_id: null,
    })).toBe(true);
  });

  test("never lets a manual edit overwrite Stripe's provider-owned period", () => {
    expect(shouldSyncManualPixBillingPeriod({
      source: "stripe",
      access_type: "monthly_subscription",
      stripe_customer_id: "cus_test",
      stripe_subscription_id: "sub_test",
    })).toBe(false);
  });

  test("maps the Pix expiry and billing period through the same Brazilian date conversion", () => {
    const mapped = mapLicense({
      id: 77,
      license_key: "MERLIN-TEST-TEST-TEST",
      name: "Teste",
      contact: "test@example.com",
      contact_type: "email",
      source: "mercadopago_pix",
      recovery_pin_hash: null,
      recovery_notice_accepted_at: null,
      hwid: null,
      expires_at: "2026-09-19T02:59:59.999Z",
      status: "active",
      revoked_reason: null,
      access_type: "monthly_subscription",
      billing_current_period_start: "2026-09-18T06:44:07.601Z",
      billing_current_period_end: "2026-09-19T02:59:59.999Z",
      billing_cancel_at_period_end: 1,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    });

    expect(mapped.expiresAt).toBe("2026-09-18");
    expect(mapped.billingCurrentPeriodEnd).toBe("2026-09-18");
  });
});
