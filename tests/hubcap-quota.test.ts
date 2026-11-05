import { afterEach, describe, expect, test, vi } from "vitest";
import { getHubcapCircuitStatus, hubcapQuotaAllows, nextHubcapQuotaCheck } from "../src/lib/hubcap-quota";

function database() {
  const rows = new Map<string, number>();
  const db = { prepare: (sql: string) => ({ bind: (key: string, expiry?: number) => ({
    first: async () => rows.has(key) ? { retry_after: rows.get(key) } : null,
    run: async () => { if (sql.startsWith("DELETE")) rows.delete(key); else rows.set(key, expiry!); },
  }) }) } as unknown as D1Database;
  return { db, rows };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("Hubcap quota circuit", () => {
  test("waits until 06:00 UTC and retries every five minutes if still exhausted", () => {
    expect(nextHubcapQuotaCheck(Date.parse("2026-07-01T04:30:00Z"))).toBe(Date.parse("2026-07-01T06:00:00Z"));
    expect(nextHubcapQuotaCheck(Date.parse("2026-12-01T05:30:00Z"))).toBe(Date.parse("2026-12-01T06:00:00Z"));
    expect(nextHubcapQuotaCheck(Date.parse("2026-12-01T06:00:00Z"), true)).toBe(Date.parse("2026-12-01T06:05:00Z"));
    expect(nextHubcapQuotaCheck(Date.parse("2026-12-01T14:00:00Z"))).toBe(Date.parse("2026-12-02T06:00:00Z"));
  });
  test("opens on exhausted quota, skips repeated checks, and rechecks at 06:00 UTC", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T05:58:00Z")); const { db } = database();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ daily_usage: 1000, daily_limit: 1000, can_make_requests: false }))
      .mockResolvedValueOnce(Response.json({ daily_usage: 0, daily_limit: 1000, can_make_requests: true }));
    expect(await hubcapQuotaAllows(db, "key")).toBe(false);
    expect((await getHubcapCircuitStatus(db, "key")).status).toBe("open");
    expect(await hubcapQuotaAllows(db, "key")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_001);
    expect(await hubcapQuotaAllows(db, "key")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getHubcapCircuitStatus(db, "key")).status).toBe("closed");
  });
  test("isolates a new key from an open circuit", async () => {
    const { db } = database();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ daily_usage: 1000, daily_limit: 1000, can_make_requests: false }))
      .mockResolvedValueOnce(Response.json({ daily_usage: 1, daily_limit: 1000, can_make_requests: true }));
    expect(await hubcapQuotaAllows(db, "old")).toBe(false);
    expect(await hubcapQuotaAllows(db, "new")).toBe(true);
  });
  test("falls back when usage is unavailable or malformed", async () => {
    const { db } = database();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("error", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ daily_usage: 0 }));
    expect(await hubcapQuotaAllows(db, "key")).toBe(false);
    expect(await hubcapQuotaAllows(db, "key")).toBe(false);
  });
});
