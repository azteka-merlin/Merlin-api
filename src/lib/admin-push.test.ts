import { describe, expect, it } from "vitest";
import { validateAdminPushSubscription } from "./admin-push";

const keys = { p256dh: "A".repeat(87), auth: "B".repeat(22) };

describe("Admin-only push subscriptions", () => {
  it("accepts a known browser push service", () => {
    expect(validateAdminPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/example", keys }).endpoint)
      .toBe("https://fcm.googleapis.com/fcm/send/example");
  });

  it("rejects arbitrary endpoints and malformed keys", () => {
    expect(() => validateAdminPushSubscription({ endpoint: "https://example.com/steal", keys })).toThrow();
    expect(() => validateAdminPushSubscription({ endpoint: "http://fcm.googleapis.com/fcm/send/example", keys })).toThrow();
    expect(() => validateAdminPushSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys, auth: "oops" } })).toThrow();
  });
});
