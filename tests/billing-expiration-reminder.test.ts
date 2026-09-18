import { describe, expect, test } from "vitest";
import { getExpirationReminderEligibility } from "../src/lib/billing-notifications";

const reminderCandidate = {
  id: 42,
  customer_id: 8,
  license_key: "MERLIN-ABCD-EFGH-IJKL",
  name: "Teste",
  contact: "teste@example.com",
  expires_at: "2026-09-21T12:00:00.000Z",
  access_type: "monthly_subscription",
  billing_status: "active",
  stripe_customer_id: null,
  stripe_subscription_id: null,
  billing_cancel_at_period_end: 0,
  subscription_status: null,
  subscription_cancel_at_period_end: 0,
  customer_stripe_customer_id: null,
};

function contextFor(notification: { status: string } | null) {
  let call = 0;
  return {
    env: {
      merlin_db: {
        prepare: () => ({
          bind: () => ({
            first: async () => (call++ === 0 ? reminderCandidate : notification),
          }),
        }),
      },
    },
  } as never;
}

describe("admin expiration reminder eligibility", () => {
  test("shows the action only for a candidate in the reminder window", async () => {
    const result = await getExpirationReminderEligibility(
      contextFor(null),
      42,
      new Date("2026-09-18T12:00:00.000Z"),
    );

    expect(result.eligible).toBe(true);
    expect(result.eligible && result.license.id).toBe(42);
  });

  test("does not allow sending the same expiration reminder twice", async () => {
    const result = await getExpirationReminderEligibility(
      contextFor({ status: "sent" }),
      42,
      new Date("2026-09-18T12:00:00.000Z"),
    );

    expect(result).toEqual({
      eligible: false,
      reason: "Aviso já enviado para este vencimento.",
    });
  });
});
