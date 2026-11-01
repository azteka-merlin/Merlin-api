import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { assertRecentPublicEmailVerification, verifyPublicEmailCode } from "./email-verification";
import type { AppBindings } from "../types";

describe("email verification proof", () => {
  it("requires the verifying browser's proof, scoped to the email and verified row", async () => {
    let verified = false;
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() {
            if (sql.includes("code_hash")) return { id: 7, email_normalized: "person@example.com", code_hash: "irrelevant", status: "pending", verify_attempts: 0, expires_at: new Date(Date.now() + 60_000).toISOString() };
            if (sql.includes("SELECT id")) return verified && args[0] === 7 && args[1] === "person@example.com" ? { id: 7 } : null;
            return null;
          },
          async run() { verified = true; return { success: true }; },
        };
      },
    };
    const app = new Hono<{ Bindings: AppBindings }>();
    app.post("/api/public/verify", async c => c.json(await verifyPublicEmailCode(c, { email: "person@example.com", code: "12345" })));
    app.get("/api/public/protected", async c => c.json({ id: await assertRecentPublicEmailVerification(c, c.req.query("email") || "") }));
    const env = { ENVIRONMENT: "staging", SESSION_HASH_SECRET: "unit-test-secret", merlin_db: db } as unknown as AppBindings;
    const verifiedResponse = await app.request("https://example.com/api/public/verify", { method: "POST" }, env);
    expect(verifiedResponse.status).toBe(200);
    const cookie = verifiedResponse.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const call = (header?: string, email = "person@example.com") => app.request(`https://example.com/api/public/protected?email=${email}`, { headers: header ? { Cookie: header } : {} }, env);
    expect((await call()).status).toBe(403);
    expect((await call(cookie)).status).toBe(200);
    expect((await call(cookie, "other@example.com")).status).toBe(403);
    expect((await call(cookie.replace(/^merlin_email_verification=7\./, "merlin_email_verification=8."))).status).toBe(403);
  });
});
