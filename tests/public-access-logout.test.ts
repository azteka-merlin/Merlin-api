import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createPublicAccessSession,
  readPublicAccessSession,
  requirePublicAccessSession,
  revokePublicAccessSession,
} from "../src/lib/public-access-session";

describe("public access sign out", () => {
  test("revokes the database session and makes the old cookie unusable", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE public_access_sessions (
      id TEXT PRIMARY KEY, license_id INTEGER, token_hash TEXT, user_agent_hash TEXT,
      remember_device INTEGER, created_at TEXT, expires_at TEXT, last_seen_at TEXT,
      revoked_at TEXT, revoke_reason TEXT
    )`);
    const db = { prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return (sqlite.prepare(sql).get(...args as []) || null) as T | null; },
        async run() {
          const result = sqlite.prepare(sql).run(...args as []);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    } };
    const app = new Hono();
    app.post("/login", async (c) => c.json(await createPublicAccessSession(c as any, 7, true)));
    app.get("/session", async (c) => c.json({ active: Boolean(await readPublicAccessSession(c as any)) }));
    app.post("/logout", async (c) => {
      await requirePublicAccessSession(c as any, { mutate: true });
      await revokePublicAccessSession(c as any);
      return c.json({ success: true });
    });
    const env = { merlin_db: db, SESSION_HASH_SECRET: "test-only-session-secret" };
    const headers = { "user-agent": "Merlin-Logout-Test/1.0" };
    const login = await app.request("https://example.test/login", { method: "POST", headers }, env as any);
    expect(login.status).toBe(200);
    const csrfToken = (await login.json() as { csrfToken: string }).csrfToken;
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("merlin_public_access_session=");
    const session = await app.request("https://example.test/session", {
      headers: { ...headers, cookie: cookie! },
    }, env as any);
    expect(await session.json()).toEqual({ active: true });

    const logout = await app.request("https://example.test/logout", {
      method: "POST", headers: { ...headers, cookie: cookie!, "x-merlin-access-csrf": csrfToken },
    }, env as any);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(sqlite.prepare("SELECT revoked_at, revoke_reason FROM public_access_sessions").get())
      .toMatchObject({ revoked_at: expect.any(String), revoke_reason: "logout" });

    const reused = await app.request("https://example.test/session", {
      headers: { ...headers, cookie: cookie! },
    }, env as any);
    expect(await reused.json()).toEqual({ active: false });
    sqlite.close();
  });
});
