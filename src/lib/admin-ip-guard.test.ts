import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { adminIpGuard } from "./admin-ip-guard";
import type { AppBindings } from "../types";

function fixture(record: unknown) {
  let lookups = 0;
  const env = {
    SESSION_HASH_SECRET: "test-secret",
    merlin_db: {
      prepare: () => ({
        bind: () => ({ first: async () => { lookups++; return record; } }),
      }),
    },
  } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>();
  app.use("*", adminIpGuard);
  app.all("*", c => c.text("ok"));
  const request = (path: string) => app.request(path, {
    headers: { "cf-connecting-ip": "203.0.113.1" },
  }, env);
  return { request, getLookups: () => lookups };
}

describe("admin IP guard", () => {
  it("blocks the site and panel API while a login block is active", async () => {
    const f = fixture({ failed_count: 5, blocked_until: "2999-01-01T00:00:00Z", manually_unblocked_at: null });
    for (const path of ["/login", "/assets/app.js", "/download", "/panel-api/auth/login"]) {
      const response = await f.request(path);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("allows expired and manually lifted blocks immediately", async () => {
    for (const record of [
      null,
      { failed_count: 5, blocked_until: "2000-01-01T00:00:00Z", manually_unblocked_at: null },
      { failed_count: 5, blocked_until: "2999-01-01T00:00:00Z", manually_unblocked_at: "2026-01-01T00:00:00Z" },
      { failed_count: 4, blocked_until: null, manually_unblocked_at: null },
    ]) {
      expect((await fixture(record).request("/login")).status).toBe(200);
    }
  });

  it("does not interfere with launcher and public API endpoints", async () => {
    const f = fixture({ failed_count: 5, blocked_until: null, manually_unblocked_at: null });
    for (const path of ["/api/health", "/payment/webhooks/stripe", "/merlin-cloud", "/merlin-cloud/steam/123/456/save", "/internal/custom-game-indexing/status"]) {
      expect((await f.request(path)).status).toBe(200);
    }
    expect(f.getLookups()).toBe(0);
  });
});
