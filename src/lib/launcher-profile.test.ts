import { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../types";

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => ({ success: true, deliveryMode: "staging_test" })),
  verify: vi.fn(async () => ({ success: true, verified: true })),
  consume: vi.fn(async () => undefined),
}));
vi.mock("./launcher-auth", () => ({ requireLauncherSearchLicense: async () => ({ id: 7 }) }));
vi.mock("./rate-limit", () => ({ enforcePublicAccessKeyRateLimit: async () => undefined }));
vi.mock("./email-verification", () => ({
  startPublicEmailVerification: mocks.start,
  verifyPublicEmailCode: mocks.verify,
  consumePublicEmailVerification: mocks.consume,
}));

import { getLauncherProfile, startLauncherProfileEmailChange, updateLauncherProfile } from "./launcher-profile";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE licenses (id INTEGER PRIMARY KEY, license_key TEXT, name TEXT, contact TEXT,
    contact_type TEXT, profile_phone TEXT, customer_id INTEGER, updated_at TEXT);
    CREATE TABLE email_verifications (id INTEGER PRIMARY KEY, email_normalized TEXT, status TEXT);`);
  sqlite.prepare("INSERT INTO licenses VALUES (7, ?, 'First Name', 'first@example.com', 'email', NULL, NULL, '')")
    .run("MERLIN-TEST-TEST-TEST");
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first<T>() { return statement.get(...args as []) as T | undefined; },
        async run() { const result = statement.run(...args as []); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  const c = { env: { merlin_db: db }, header() {} } as unknown as AppContext;
  return { c, sqlite };
}

beforeEach(() => { mocks.start.mockClear(); mocks.verify.mockClear(); mocks.consume.mockClear(); });

describe("launcher license profile", () => {
  it("returns only the signed-in license and saves name and optional phone without changing email", async () => {
    const { c, sqlite } = fixture();
    expect(await getLauncherProfile(c)).toMatchObject({ name: "First Name", email: "first@example.com", phone: null });
    const result = await updateLauncherProfile(c, { name: "New Name", email: "first@example.com", phone: "+55 11 99999-9999" });
    expect(result).toMatchObject({ name: "New Name", phone: "+55 11 99999-9999" });
    expect(sqlite.prepare("SELECT contact FROM licenses WHERE id = 7").get()).toMatchObject({ contact: "first@example.com" });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("does not reveal another license's email until the new address is verified", async () => {
    const { c, sqlite } = fixture();
    sqlite.prepare("INSERT INTO licenses VALUES (8, ?, 'Other', 'other@example.com', 'email', NULL, NULL, '')")
      .run("MERLIN-OTHR-OTHR-OTHR");
    await expect(startLauncherProfileEmailChange(c, "other@example.com"))
      .resolves.toMatchObject({ success: true });
    expect(mocks.start).toHaveBeenCalledWith(c, "other@example.com");
    mocks.verify.mockRejectedValueOnce(new HTTPException(400, { message: "Código de verificação inválido." }));
    await expect(updateLauncherProfile(c, { name: "First Name", email: "other@example.com", phone: null, emailCode: "00000" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(updateLauncherProfile(c, { name: "First Name", email: "other@example.com", phone: null, emailCode: "12345" }))
      .rejects.toMatchObject({ status: 409 });
    expect(sqlite.prepare("SELECT contact FROM licenses WHERE id = 7").get()).toMatchObject({ contact: "first@example.com" });
  });

  it("requires confirmation at the new address before changing the license email", async () => {
    const { c, sqlite } = fixture();
    await expect(updateLauncherProfile(c, { name: "First Name", email: "new@example.com", phone: null }))
      .rejects.toMatchObject({ status: 403 });
    expect(sqlite.prepare("SELECT contact FROM licenses WHERE id = 7").get()).toMatchObject({ contact: "first@example.com" });
    sqlite.prepare("INSERT INTO email_verifications VALUES (5, 'new@example.com', 'verified')").run();
    const result = await updateLauncherProfile(c, { name: "First Name", email: "new@example.com", phone: null, emailCode: "123456" });
    expect(result.email).toBe("new@example.com");
    expect(mocks.verify).toHaveBeenCalledWith(c, { email: "new@example.com", code: "123456" });
    expect(mocks.consume).toHaveBeenCalledWith(c, 5);
  });
});
