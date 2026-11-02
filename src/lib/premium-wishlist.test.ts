import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import type { AppContext } from "../types";
import { listAdminPremiumWishes, listPremiumWishes, removePremiumWish, savePremiumWish } from "./premium-wishlist";

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE licenses(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE premium_games(app_id TEXT PRIMARY KEY,name TEXT,cover_url TEXT,enabled INTEGER,updated_at TEXT DEFAULT 'x');
    CREATE TABLE premium_activations(id INTEGER PRIMARY KEY,license_id INTEGER);
    INSERT INTO licenses VALUES(1,'Um'),(2,'Dois');
    INSERT INTO premium_games(app_id,name,cover_url,enabled) VALUES('123','Jogo',NULL,1),('456','Outro',NULL,1);`);
  db.exec(readFileSync(new URL("../../migrations/0090_premium_wishes_and_retries.sql", import.meta.url), "utf8"));
  db.exec("UPDATE premium_games SET coming_soon=1 WHERE app_id='123'");
  const env = { merlin_db: { prepare(sql: string) { return { bind(...args: unknown[]) { return {
    async run() { const value = db.prepare(sql).run(...args as []); return { meta: { changes: Number(value.changes) } }; },
    async all() { return { results: db.prepare(sql).all(...args as []) }; },
  }; } }; } } };
  return { db, c: { env } as unknown as AppContext };
}

describe("premium wishlist", () => {
  it("requires consent for a phone and only accepts upcoming games", async () => {
    const h = harness();
    await expect(savePremiumWish(h.c, 1, "123", { email: "a@example.com", phone: "123" })).rejects.toThrow();
    await expect(savePremiumWish(h.c, 1, "456", { email: "a@example.com" })).rejects.toThrow();
    await expect(savePremiumWish(h.c, 1, "123", { email: "invalid" })).rejects.toThrow();
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM premium_wishlist").get()?.count).toBe(0);
    h.db.close();
  });

  it("keeps interests private to the license and allows removal and restoration", async () => {
    const h = harness();
    await savePremiumWish(h.c, 1, "123", { email: "one@example.com", phone: "11999999999", phoneConsent: true });
    await savePremiumWish(h.c, 2, "123", { email: "two@example.com" });
    expect(await listPremiumWishes(h.c, 1)).toHaveLength(1);
    expect(await removePremiumWish(h.c, 1, "123")).toBe(true);
    expect(await listPremiumWishes(h.c, 1)).toHaveLength(0);
    expect(await listPremiumWishes(h.c, 2)).toHaveLength(1);
    const admin = await listAdminPremiumWishes(h.c, "123");
    expect(admin.wishes).toHaveLength(1);
    expect(admin.wishes[0]).toMatchObject({ licenseId: 2, email: "two@example.com" });
    await savePremiumWish(h.c, 1, "123", { email: "new@example.com" });
    const row = h.db.prepare("SELECT email,phone,phone_consent_at FROM premium_wishlist WHERE license_id=1").get();
    expect(row).toEqual({ email: "new@example.com", phone: null, phone_consent_at: null });
    h.db.close();
  });
});
