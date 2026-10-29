import { describe, expect, it } from "vitest";
import { addReactivationEvidence } from "./reactivation-evidence";

describe("reactivation evidence", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");

  it("records the prior expiry for a license that had lapsed", () => {
    const result = JSON.parse(addReactivationEvidence(
      JSON.stringify({ amountCents: 1490 }),
      { status: "expired", expires_at: "2026-10-20T12:00:00.000Z" },
      now,
    ));
    expect(result).toMatchObject({
      amountCents: 1490,
      reactivationReason: "expired",
      reactivationPreviousExpiresAt: "2026-10-20T12:00:00.000Z",
    });
  });

  it("does not count a free-to-paid conversion or revoked license as a winback", () => {
    const free = JSON.parse(addReactivationEvidence("{}", { status: "active", expires_at: "2026-11-20T12:00:00.000Z" }, now));
    const revoked = JSON.parse(addReactivationEvidence("{}", { status: "revoked", expires_at: "2026-10-20T12:00:00.000Z" }, now));
    expect(free.reactivationReason).toBe("free_to_paid");
    expect(free.reactivationPreviousExpiresAt).toBeNull();
    expect(revoked.reactivationReason).toBe("revoked");
    expect(revoked.reactivationPreviousExpiresAt).toBeNull();
  });
});
