import { describe, expect, test } from "vitest";
import { describePremiumSlots } from "../src/lib/premium-games";
import worker from "../src/index";

const now = new Date("2026-11-05T12:00:00Z");
function activation(id: number, status: string, activated: string | null, reserved: string | null = null, retryOf: number | null = null) {
  return { id, license_id: id, app_id: "400", status, activated_at: activated, reserved_at: reserved,
    cooldown_until: "2026-11-09T00:00:00Z", failure_stage: null, failure_reason: null,
    created_at: now.toISOString(), updated_at: now.toISOString(), retry_of: retryOf } as any;
}
describe("admin premium slot overview", () => {
  test("shows actual slot release, not the user's longer cooldown, and excludes expired reservations", () => {
    const rows = [activation(1, "active", "2026-11-05T08:00:00Z"),
      activation(2, "processing", null, "2026-11-05T11:59:00Z"),
      activation(3, "reserved", null, "2026-11-05T11:00:00Z")];
    expect(describePremiumSlots(4, rows, [], now)).toEqual({ total: 4, occupied: 2, available: 2, entries: [
      { status: "processing", availableAt: "2026-11-05T12:02:00.000Z" },
      { status: "active", availableAt: "2026-11-06T08:00:00.000Z" },
    ] });
  });
  test("support retries retain one slot without a misleading release time", () => {
    const rows = [activation(1, "active", "2026-11-05T08:00:00Z"), activation(2, "processing", null, "2026-11-05T11:59:00Z", 1),
      activation(3, "active", "2026-11-03T08:00:00Z")];
    const retries = [{ activationId: 1, appId: "400", status: "review", activatedAt: "2026-11-05T08:00:00Z" },
      { activationId: 3, appId: "400", status: "available", activatedAt: "2026-11-03T08:00:00Z" }] as const;
    expect(describePremiumSlots(3, rows, [...retries], now)).toEqual({ total: 3, occupied: 2, available: 1, entries: [
      { status: "retry_review", availableAt: null }, { status: "retry_available", availableAt: null },
    ] });
  });
  test("requires an admin session", async () => {
    const response = await worker.fetch(new Request("https://admin.api-merlin.com/panel-api/premium/games/400/slots"), {
      SESSION_HASH_SECRET: "test", ADMIN_APP_HOST: "admin.api-merlin.com",
      merlin_db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as any);
    expect(response.status).toBe(401);
  });
});
