import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { Hono } from "hono";
import type { AppBindings } from "../types";
import { cleanupCustomGamePackages, registerCustomGamesRoutes } from "./custom-games";
import { integrityManifestKey } from "./custom-game-integrity";
import { installFixedLengthStreamMock } from "./test-support/install-fixed-length-stream-mock";

installFixedLengthStreamMock();

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn(async () => ({ session: { admin_user_id: 1 } })) }));
vi.mock("./launcher-auth", () => ({ requireGoldLauncherLicense: vi.fn(async () => ({ id: 1, planTier: "ouro" })) }));
const SHA = "a".repeat(64);
const oldTime = new Date(Date.now() - 25 * 3600_000).toISOString();
type Stored = { value: string | Uint8Array; etag: string; customMetadata: Record<string, string> };

function harness() {
  const gameId = crypto.randomUUID();
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0082_custom_games.sql", "0083_custom_games_folder_packages.sql", "0085_custom_game_versions.sql"]) {
    db.exec(readFileSync(new NodeURL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const stored = new Map<string, Stored>();
  const deleted: string[] = [];
  let revision = 0;
  const metadata = (key: string, value: Stored) => ({ key, etag: value.etag,
    size: typeof value.value === "string" ? new TextEncoder().encode(value.value).byteLength : value.value.byteLength,
    uploaded: new Date(), customMetadata: value.customMetadata });
  const bucket = {
    async head(key: string) { const value = stored.get(key); return value ? metadata(key, value) : null; },
    async get(key: string, options: any = {}) {
      const value = stored.get(key); if (!value) return null;
      const completeBytes = typeof value.value === "string" ? new TextEncoder().encode(value.value) : value.value;
      const bytes = options.range ? completeBytes.slice(options.range.offset, options.range.offset + options.range.length) : completeBytes;
      return { ...metadata(key, value), body: new Blob([bytes]).stream(),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)), text: async () => new TextDecoder().decode(bytes) };
    },
    async put(key: string, input: string | Uint8Array | ReadableStream<Uint8Array>, options: any = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && stored.has(key)) return null;
      const value = input instanceof ReadableStream ? new Uint8Array(await new Response(input).arrayBuffer()) : input;
      const entry = { value, etag: `etag-${++revision}`, customMetadata: options.customMetadata || {} };
      stored.set(key, entry); return metadata(key, entry);
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) { deleted.push(key); stored.delete(key); } },
  };
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = { sql, get values() { return args; }, bind(...values: unknown[]) { args = values; return statement; },
      async first<T>() { return (db.prepare(sql).get(...args as []) || null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...args as []) as T[] }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args as []).changes) } }; } };
    return statement;
  };
  const env = { ENVIRONMENT: "production", CUSTOM_GAMES: bucket, merlin_db: { prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } } } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>(); registerCustomGamesRoutes(app);
  const file = (path: string, key = `${gameId}/files/${crypto.randomUUID()}`) => ({ id: key.slice(-36), path, key, sizeBytes: 3, sha256: SHA });
  const manifest = async (files: ReturnType<typeof file>[], key = `${gameId}/manifests/${crypto.randomUUID()}.json`) => {
    for (const file of files) if (!stored.has(file.key)) await bucket.put(file.key, new Uint8Array([1, 2, 3]));
    await bucket.put(key, JSON.stringify({ version: 3, totalSizeBytes: files.length * 3, files, bundles: [] }));
    return key;
  };
  const catalog = (key: string, { id = gameId, packageType = "folder", size = 6 } = {}) => {
    db.prepare(`INSERT INTO custom_games (id,name,install_name,image_key,archive_key,archive_size,package_type,published)
      VALUES (?,?,?,'image',?,?,?,1)`).run(id, id, id, key, size, packageType);
  };
  const version = (key: string, { status = "retired", size = 6 } = {}) => {
    db.prepare(`INSERT INTO custom_game_versions (game_id,archive_key,package_type,archive_size,status,delete_after,legacy_hold)
      VALUES (?,?,'folder',?,?,?,0)`).run(gameId, key, size, status, oldTime);
  };
  const post = (path: string, body: unknown) => app.request(`https://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, env);
  return { gameId, db, stored, deleted, bucket, env, app, file, manifest, catalog, version, post };
}

beforeEach(() => vi.clearAllMocks());

describe("custom game package lifecycle adversarial cases", () => {
  it("publishes a v4 package and serves existing Launcher manifest, file-range and integrity contracts", async () => {
    const h = harness();
    const manifestId = crypto.randomUUID();
    const manifestKey = `${h.gameId}/manifests/${manifestId}.json`;
    const partKey = `${h.gameId}/manifest-parts/${manifestId}/000000.json`;
    const file = h.file("bin/game.exe");
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const uploaded = await h.bucket.put(file.key, bytes);
    if (!uploaded) throw new Error("synthetic object PUT failed");
    const fileId = file.id;
    await h.bucket.put(partKey, JSON.stringify({ entries: [{ kind: "file", id: fileId, path: file.path,
      key: file.key, sizeBytes: bytes.length, sha256: SHA, etag: uploaded.etag }] }));
    await h.bucket.put(manifestKey, JSON.stringify({ version: 4, totalSizeBytes: bytes.length, parts: [{ key: partKey }], objects: {
      [fileId]: { key: file.key, sizeBytes: bytes.length, sha256: SHA, etag: uploaded.etag, kind: "file", parts: [0] },
    } }));

    const form = new FormData();
    form.set("gameId", h.gameId); form.set("name", "Large Folder Fixture"); form.set("origin", "native");
    form.set("protectedPaths", "[]"); form.set("adminNote", ""); form.set("adminNotes", "{}");
    form.set("executablePath", "bin/game.exe"); form.set("packageType", "folder");
    form.set("archiveKey", manifestKey); form.set("published", "true");
    form.set("image", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "cover.png", { type: "image/png" }));
    const saved = await h.app.request("https://localhost/panel-api/custom-games", { method: "POST", body: form }, h.env);
    expect(saved.status).toBe(201);
    expect(h.db.prepare("SELECT archive_key,archive_size,package_type,published FROM custom_games WHERE id=?").get(h.gameId))
      .toMatchObject({ archive_key: manifestKey, archive_size: bytes.length, package_type: "folder", published: 1 });

    const response = await h.app.request(`https://localhost/api/custom-games/${h.gameId}/manifest`, {}, h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ gameId: h.gameId, archiveKey: manifestKey, totalSizeBytes: 4,
      files: [{ id: fileId, path: "bin/game.exe", sizeBytes: 4, sha256: SHA }] });
    const range = await h.app.request(`https://localhost/api/custom-games/${h.gameId}/files/${fileId}`, {
      headers: { range: "bytes=1-2" },
    }, h.env);
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(new Uint8Array([22, 33]));
    const integrity = await h.app.request(`https://localhost/api/custom-games/${h.gameId}/integrity`, {}, h.env);
    expect(integrity.status).toBe(200);
    expect(await integrity.json()).toMatchObject({ gameId: h.gameId, archiveKey: manifestKey,
      files: [{ path: "bin/game.exe", sizeBytes: 4, sha256: SHA }] });
  });

  it("never overwrites a published folder key and accepts a replay with identical content", async () => {
    const h = harness();
    const file = h.file("main.exe"); await h.bucket.put(file.key, new Uint8Array([1, 2, 3]));
    const manifestId = crypto.randomUUID(); const key = `${h.gameId}/manifests/${manifestId}.json`;
    const payload = { gameId: h.gameId, manifestId, files: [file], bundles: [] };
    expect((await h.post("/panel-api/custom-games/upload/folder/complete", payload)).status).toBe(201);
    h.catalog(key, { size: 3 }); const before = h.stored.get(key)!;
    expect((await h.post("/panel-api/custom-games/upload/folder/complete", payload)).status).toBe(201);
    expect(h.stored.get(key)?.etag).toBe(before.etag);
    const conflict = await h.post("/panel-api/custom-games/upload/folder/complete", { ...payload, files: [{ ...file, path: "different.exe" }] });
    expect(conflict.status).toBe(409);
    expect(h.stored.get(key)?.value).toBe(before.value);
    expect(h.stored.get(key)?.etag).toBe(before.etag);
  });

  it.each(["active", "retired", "deleting"])("refuses to discard objects referenced by a %s snapshot", async status => {
    const h = harness(); const file = h.file("shared.dll"); const key = await h.manifest([file]);
    h.version(key, { status, size: 3 });
    const response = await h.post("/panel-api/custom-games/upload/discard", { key: file.key });
    expect(response.status).toBe(409); expect(h.stored.has(file.key)).toBe(true); expect(h.deleted).toEqual([]);
  });

  it("refuses to discard an object referenced by the current catalog even before snapshot backfill", async () => {
    const h = harness(); const file = h.file("shared.dll"); const key = await h.manifest([file]); h.catalog(key, { size: 3 });
    expect((await h.post("/panel-api/custom-games/upload/discard", { key: file.key })).status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("can discard objects whose only snapshot has already been deleted", async () => {
    const h = harness(); const file = h.file("obsolete.dll"); const key = await h.manifest([file]);
    h.version(key, { status: "deleted", size: 3 });
    expect((await h.post("/panel-api/custom-games/upload/discard", { key: file.key })).status).toBe(200);
    expect(h.deleted).toEqual([file.key]);
  });

  it("cleans an old folder while preserving the shared files of its current replacement", async () => {
    const h = harness(); const shared = h.file("shared.dll"); const obsolete = h.file("old.dll"); const fresh = h.file("new.dll");
    const oldKey = await h.manifest([shared, obsolete]); const newKey = await h.manifest([shared, fresh]);
    h.catalog(newKey); h.version(oldKey); h.version(newKey, { status: "active" });
    const result = await cleanupCustomGamePackages(h.env);
    expect(result).toEqual({ deleted: 1, skipped: 0, failed: 0 });
    expect(h.stored.has(oldKey)).toBe(false); expect(h.stored.has(obsolete.key)).toBe(false);
    expect(h.stored.has(shared.key)).toBe(true); expect(h.stored.has(newKey)).toBe(true); expect(h.stored.has(fresh.key)).toBe(true);
    expect(h.stored.has(await integrityManifestKey(h.gameId, oldKey))).toBe(true);
    expect(h.db.prepare("SELECT status FROM custom_game_versions WHERE archive_key=?").get(oldKey)?.status).toBe("deleted");
  });

  it("blocks deleting shared legacy objects referenced by a different game", async () => {
    const h = harness(); const globalKey = `game-files/${crypto.randomUUID()}`; const shared = h.file("legacy.dll", globalKey);
    const manifestKey = await h.manifest([shared], `manifests/${crypto.randomUUID()}.json`);
    h.catalog(manifestKey, { id: crypto.randomUUID(), size: 3 });
    expect((await h.post("/panel-api/custom-games/upload/discard", { key: globalKey })).status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("fails closed if another referenced manifest cannot be read", async () => {
    const h = harness(); const file = h.file("possible-shared.dll"); await h.bucket.put(file.key, new Uint8Array([1, 2, 3]));
    h.catalog(`${h.gameId}/manifests/${crypto.randomUUID()}.json`, { size: 3 });
    expect((await h.post("/panel-api/custom-games/upload/discard", { key: file.key })).status).toBe(409);
    expect(h.deleted).toEqual([]);
  });
});
