import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerCustomGamesRoutes } from "./custom-games";
import { requireGoldLauncherLicense } from "./launcher-auth";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn(async () => ({ session: { admin_user_id: 1 } })) }));
vi.mock("./launcher-auth", () => ({ requireGoldLauncherLicense: vi.fn() }));
const id = "40000000-0000-4000-8000-000000000000";
const oldKey = `${id}/archives/40000000-0000-4000-8000-000000000001.zip`;
const newKey = `${id}/archives/40000000-0000-4000-8000-000000000002.zip`;
const protocol = { "x-merlin-custom-games-protocol": "2" };
const sha = (data: string) => createHash("sha256").update(data).digest("hex");

function harness() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0082_custom_games.sql", "0083_custom_games_folder_packages.sql", "0085_custom_game_versions.sql"])
    db.exec(readFileSync(new NodeURL(`../../migrations/${file}`, import.meta.url), "utf8"));
  db.prepare(`INSERT INTO custom_games (id,name,install_name,image_key,archive_key,archive_size,executable_path,published)
    VALUES (?,?,?,'image',?,8,'game.exe',1)`).run(id, "Test Game", "Test Game", oldKey);
  type Stored = { data: Uint8Array; etag: string; customMetadata?: Record<string, string>; uploaded?: Date };
  const objects = new Map<string, Stored>();
  const store = (key: string, value: string, etag = sha(value)) => objects.set(key, { data: new TextEncoder().encode(value), etag, uploaded: new Date() });
  store(oldKey, "AAAABBBB"); store(newKey, "11112222");
  const hooks = { failUpdate: false, deleteBeforeNextBatch: false };
  function prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async first<T>() { return (db.prepare(sql).get(...values as []) || null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...values as []) as T[] }; },
      async run() { if (hooks.failUpdate && sql.startsWith("UPDATE custom_games SET name=")) throw new Error("transaction_failure");
        return { meta: { changes: Number(db.prepare(sql).run(...values as []).changes) } }; },
    };
    return statement;
  }
  const bucket = {
    async head(key: string) { const obj = objects.get(key); return obj ? { key, size: obj.data.length, etag: obj.etag, customMetadata: obj.customMetadata, uploaded: obj.uploaded || new Date() } : null; },
    async get(key: string, options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } }) {
      const obj = objects.get(key); if (!obj) return null;
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== obj.etag) return { key, size: obj.data.length, etag: obj.etag };
      const bytes = options?.range ? obj.data.slice(options.range.offset, options.range.offset + options.range.length) : obj.data;
      return { key, size: obj.data.length, etag: obj.etag, customMetadata: obj.customMetadata,
        body: new Response(bytes).body, json: async () => JSON.parse(new TextDecoder().decode(obj.data)), text: async () => new TextDecoder().decode(obj.data) };
    },
    async put(key: string, data: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) {
      const prior = objects.get(key);
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== prior?.etag) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && prior) return null;
      const value = String(data); store(key, value); objects.get(key)!.customMetadata = options?.customMetadata;
      return { key, etag: objects.get(key)!.etag };
    },
    delete: vi.fn(async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) objects.delete(k); }),
    async list({ prefix = "" } = {}) { return { objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, v]) => ({ key, etag: v.etag, size: v.data.length, customMetadata: v.customMetadata })), truncated: false }; },
  };
  let batchTail: Promise<unknown> = Promise.resolve();
  const env = { CUSTOM_GAMES: bucket, merlin_db: { prepare, batch(statements: ReturnType<typeof prepare>[]) {
    const result = batchTail.then(async () => {
      if (hooks.deleteBeforeNextBatch) { hooks.deleteBeforeNextBatch = false; db.prepare("UPDATE custom_games SET published=0,deleted_at=? WHERE id=?").run(new Date().toISOString(), id); }
      db.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    batchTail = result.catch(() => {}); return result;
  } } } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>(); registerCustomGamesRoutes(app);
  app.onError((error, c) => c.json({ error: error.message, code: (error as { code?: string }).code }, (error as { status?: number }).status as 400 || 500));
  async function session(key = oldKey) {
    const response = await app.request(`http://localhost/api/custom-games/${id}/download-session`, { method: "POST",
      headers: { ...protocol, "content-type": "application/json" }, body: JSON.stringify({ archiveKey: key }) }, env);
    expect(response.status).toBe(200); return await response.json() as { leaseId: string };
  }
  async function publish(key = newKey) {
    const form = new FormData(); form.set("name", "Test Game"); form.set("published", "true"); form.set("archiveKey", key);
    form.set("packageType", "zip"); form.set("executablePath", "new.exe"); form.set("origin", "port"); form.set("versionLabel", "2");
    return app.request(`http://localhost/panel-api/custom-games/${id}`, { method: "PUT", body: form }, env);
  }
  return { app, env, db, bucket, objects, store, hooks, session, publish };
}

beforeEach(() => vi.mocked(requireGoldLauncherLicense).mockResolvedValue({ id: 132, planTier: "ouro" } as Awaited<ReturnType<typeof requireGoldLauncherLicense>>));

describe("publishing complete game packages safely", () => {
  it("a ZIP download at 50 percent remains on its old version after publication", async () => {
    const h = harness(); const { leaseId } = await h.session();
    const url = `http://localhost/api/custom-games/${id}/archive?archiveKey=${encodeURIComponent(oldKey)}&downloadSessionId=${leaseId}`;
    expect(await (await h.app.request(url, { headers: { ...protocol, range: "bytes=0-3" } }, h.env)).text()).toBe("AAAA");
    expect((await h.publish()).status).toBe(200);
    expect(await (await h.app.request(url, { headers: { ...protocol, range: "bytes=4-7" } }, h.env)).text()).toBe("BBBB");
    expect(h.bucket.delete).not.toHaveBeenCalled();
    const modern = await (await h.app.request("http://localhost/api/custom-games", { headers: protocol }, h.env)).json() as any;
    const legacy = await (await h.app.request("http://localhost/api/custom-games", {}, h.env)).json() as any;
    expect(modern.games[0]).toMatchObject({ archiveKey: newKey, origin: "port", protectedPaths: [], versionLabel: "2" });
    expect(legacy.games[0].archiveKey).toBe(oldKey);
    expect(await (await h.app.request(`http://localhost/api/custom-games/${id}/archive`, { headers: { range: "bytes=4-7" } }, h.env)).text()).toBe("BBBB");
  });
  it("rolls back publication on database failure without touching current objects", async () => {
    const h = harness(); await h.session(); h.hooks.failUpdate = true;
    expect((await h.publish()).status).toBe(500);
    expect(h.db.prepare("SELECT archive_key FROM custom_games WHERE id=?").get(id)?.archive_key).toBe(oldKey);
    expect(h.db.prepare("SELECT COUNT(*) n FROM custom_game_versions WHERE archive_key=?").get(newKey)?.n).toBe(0);
    expect(h.objects.has(oldKey)).toBe(true); expect(h.bucket.delete).not.toHaveBeenCalled();
  });
  it("metadata-only edits update the active snapshot without changing content version", async () => {
    const h = harness(); await h.session(); expect((await h.publish(oldKey)).status).toBe(200);
    const result = h.db.prepare("SELECT origin,protected_paths_json,executable_path,status FROM custom_game_versions WHERE game_id=? AND archive_key=?").get(id, oldKey);
    expect(result).toMatchObject({ origin: "port", protected_paths_json: '[]', executable_path: "new.exe", status: "active" });
  });
  it("concurrent publications retire every superseded version", async () => {
    const h = harness(); await h.session();
    const thirdKey = `${id}/archives/40000000-0000-4000-8000-000000000003.zip`; h.store(thirdKey, "33334444");
    const responses = await Promise.all([h.publish(), h.publish(thirdKey)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const current = h.db.prepare("SELECT archive_key FROM custom_games WHERE id=?").get(id)!.archive_key;
    const active = h.db.prepare("SELECT archive_key FROM custom_game_versions WHERE game_id=? AND status='active'").all(id);
    expect(active).toHaveLength(1); expect(active[0]!.archive_key).toBe(current);
  });
  it("a concurrent admin save cannot resurrect a deleted game", async () => {
    const h = harness(); await h.session(); h.hooks.deleteBeforeNextBatch = true;
    expect((await h.publish()).status).toBe(404);
    expect(h.db.prepare("SELECT published,archive_key,deleted_at FROM custom_games WHERE id=?").get(id)).toMatchObject({ published: 0, archive_key: oldKey });
    expect(h.db.prepare("SELECT COUNT(*) n FROM custom_game_versions WHERE archive_key=?").get(newKey)?.n).toBe(0);
  });
  it("admin deletion hides a game while preserving an active pinned download", async () => {
    const h = harness(); const { leaseId } = await h.session();
    expect((await h.app.request(`http://localhost/panel-api/custom-games/${id}`, { method: "DELETE" }, h.env)).status).toBe(200);
    const catalog = await (await h.app.request("http://localhost/api/custom-games", { headers: protocol }, h.env)).json() as any;
    expect(catalog.games).toEqual([]);
    const chunk = await h.app.request(`http://localhost/api/custom-games/${id}/archive?archiveKey=${encodeURIComponent(oldKey)}&downloadSessionId=${leaseId}`,
      { headers: { ...protocol, range: "bytes=4-7" } }, h.env);
    expect(chunk.status).toBe(206); expect(await chunk.text()).toBe("BBBB");
    expect(h.objects.has(oldKey)).toBe(true);
  });
  it.each([0, 8, 9])("serves only the indexed compressed member bytes for method %s and rejects a replaced ZIP", async method => {
    const h = harness(); h.store(oldKey, "H".repeat(30) + "abcd");
    h.db.prepare("UPDATE custom_games SET archive_size=34 WHERE id=?").run(id);
    const { leaseId } = await h.session();
    const jobId = sha(id + oldKey);
    h.store(`${id}/integrity/${jobId}.json`, JSON.stringify({ version: 1, gameId: id, archiveKey: oldKey, totalSizeBytes: 4,
      sourceEtag: h.objects.get(oldKey)!.etag, sourceSize: 34, indexedAt: new Date().toISOString(),
      files: [{ path: "game.exe", sizeBytes: 4, sha256: sha("abcd"), zip: { offset: 30, compressedSize: 4, method, crc32: 0 } }] }));
    const url = `http://localhost/api/custom-games/${id}/entries/0?archiveKey=${encodeURIComponent(oldKey)}&downloadSessionId=${leaseId}`;
    const response = await h.app.request(url, { headers: { ...protocol, range: "bytes=1-2" } }, h.env);
    expect(response.status).toBe(206); expect(await response.text()).toBe("bc"); expect(response.headers.get("content-range")).toBe("bytes 1-2/4");
    h.store(oldKey, "H".repeat(30) + "wxyz");
    expect((await h.app.request(url, { headers: { ...protocol, range: "bytes=1-2" } }, h.env)).status).toBe(409);
  });
  it("indexes a real ZIP through the runner and API, then downloads an individual member", async () => {
    const h = harness();
    const name = Buffer.from("game.exe"); const data = Buffer.from("ABCD");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
    const archive = Buffer.concat([local, name, data, central, name, end]);
    h.objects.set(oldKey, { data: archive, etag: createHash("sha256").update(archive).digest("hex") });
    h.db.prepare("UPDATE custom_games SET archive_size=? WHERE id=?").run(archive.length, id);
    h.env.CUSTOM_GAME_INDEXER_SECRET = "test-indexer-private";
    const enqueue = await h.app.request("http://localhost/panel-api/custom-games/indexing", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "missing", gameId: id }) }, h.env);
    expect(enqueue.status).toBe(200); expect(await enqueue.json()).toMatchObject({ queued: 1 });
    const { IndexerClient, processIndexJob } = await import("../../scripts/lib/custom-game-indexer.mjs");
    const client = new IndexerClient({ apiUrl: "http://localhost", secret: h.env.CUSTOM_GAME_INDEXER_SECRET,
      fetchImpl: (async (url: string, options: RequestInit) => {
        const response = await h.app.request(url, options, h.env);
        if (response.status >= 500) throw new Error(await response.text());
        return response;
      }) as typeof fetch });
    const { job } = await client.post("/claim", {});
    expect(job).toBeTruthy();
    const indexed = await processIndexJob(client, job);
    expect(indexed.files).toHaveLength(1); expect(indexed.files[0]).toMatchObject({ path: "game.exe", sha256: sha("ABCD"), zip: { method: 0, compressedSize: 4 } });
    const { leaseId } = await h.session();
    const response = await h.app.request(`http://localhost/api/custom-games/${id}/entries/0?archiveKey=${encodeURIComponent(oldKey)}&downloadSessionId=${leaseId}`,
      { headers: { ...protocol, range: "bytes=0-3" } }, h.env);
    expect(response.status).toBe(206); expect(await response.text()).toBe("ABCD");
    const dashboard = await (await h.app.request("http://localhost/panel-api/custom-games/indexing", {}, h.env)).json() as any;
    expect(dashboard.games[0].indexStatus).toBe("ready"); expect(dashboard.jobs[0].status).toBe("completed");
  });
});
