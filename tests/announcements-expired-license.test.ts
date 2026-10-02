import { describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { signAccessToken } from "../src/lib/auth";

describe("announcements for expired licenses", () => {
  test.each(["expired", "active"] as const)("allows limited announcement access with status %s and a past expiry", async (status) => {
    const license = {
      id: 95,
      license_key: "MERLIN-ABCD-EFGH-JKLM",
      name: "Tester",
      hwid: "device-95",
      expires_at: "2026-10-01T00:00:00.000Z",
      status,
    };
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() { return license; },
              async all() {
                if (!sql.includes("FROM announcements")) throw new Error("Unexpected query");
                return { results: [] };
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
      jti: "expired-announcements-test",
    }, "secret");
    const env = { JWT_SECRET: "secret", merlin_db: db } as any;
    const headers = { Authorization: `Bearer ${token}` };

    const announcements = await worker.fetch(new Request("https://api-merlin.com/api/announcements/eligible", { headers }), env, {} as any);
    expect(announcements.status).toBe(200);
    expect(await announcements.json()).toMatchObject({ success: true, announcement: null });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const protectedRoute = await worker.fetch(new Request("https://api-merlin.com/api/release-notes", { headers }), env, {} as any);
      expect(protectedRoute.status).toBe(401);
    } finally {
      warn.mockRestore();
    }
  });
});
