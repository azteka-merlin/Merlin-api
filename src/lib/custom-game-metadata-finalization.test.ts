import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { AppBindings } from "../types";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn().mockResolvedValue({ session: { admin_user_id: 1 } }) }));
import { registerGameUploadSessionRoutes } from "./custom-game-upload-sessions";
import { readShardedFolderIndex, streamShardedFolderManifest, streamShardedIntegrityManifest } from "./custom-game-sharded-download";

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_SHA = "a".repeat(64);
const FILE_SHA = "b".repeat(64);
const MIGRATION = readFileSync(resolve(process.cwd(), "migrations/0101_custom_game_metadata_batches.sql"), "utf8");

class LocalD1Statement {
  private values: unknown[] = [];
  constructor(private readonly owner: LocalD1, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { return this.owner.first<T>(this.sql, this.values); }
  async all<T>() { return this.owner.all<T>(this.sql, this.values); }
  async run() { return this.owner.run(this.sql, this.values); }
  runSync() { return this.owner.runSync(this.sql, this.values); }
}
class LocalD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec("PRAGMA foreign_keys=ON"); this.sqlite.exec(MIGRATION); }
  prepare(sql: string) { return new LocalD1Statement(this, sql); }
  async first<T>(sql: string, values: unknown[]) { return this.sqlite.prepare(sql).get(...values as any[]) as T | undefined || null; }
  async all<T>(sql: string, values: unknown[]) { return { results: this.sqlite.prepare(sql).all(...values as any[]) as T[] }; }
  runSync(sql: string, values: unknown[]) {
    const result = this.sqlite.prepare(sql).run(...values as any[]);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async run(sql: string, values: unknown[]) { return this.runSync(sql, values); }
  async batch(statements: LocalD1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(statement => statement.runSync());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

type StoredObject = { bytes: Uint8Array; etag: string; size: number; customMetadata?: Record<string, string> };
function makeBucket() {
  let nextEtag = 0;
  const objects = new Map<string, StoredObject>();
  const asStored = (key: string) => {
    const found = objects.get(key);
    if (!found) return null;
    return { ...found,
      text: async () => new TextDecoder().decode(found.bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(found.bytes)) as T,
      body: new Response(found.bytes).body,
    };
  };
  const bucket = {
    put: vi.fn(async (key: string, body: string | Uint8Array, options?: any) => {
      const prior = objects.get(key);
      if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && prior) return null;
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const stored = { bytes, size: bytes.byteLength, etag: `etag-${++nextEtag}`,
        ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}) };
      objects.set(key, stored);
      return stored;
    }),
    get: vi.fn(async (key: string) => asStored(key)),
    head: vi.fn(async (key: string) => {
      const found = objects.get(key);
      return found ? { size: found.size, etag: found.etag, customMetadata: found.customMetadata } : null;
    }),
    delete: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }),
    list: vi.fn(async ({ prefix, limit = 1000, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = Number(cursor || 0);
      const selected = keys.slice(offset, offset + limit);
      return { objects: selected.map(key => ({ key, ...objects.get(key)! })),
        truncated: offset + limit < keys.length, cursor: offset + limit < keys.length ? String(offset + limit) : undefined };
    }),
    objects,
  };
  return bucket;
}

function harness() {
  const db = new LocalD1();
  const bucket = makeBucket();
  const app = new Hono<{ Bindings: AppBindings }>();
  registerGameUploadSessionRoutes(app);
  const env = { CUSTOM_GAMES: bucket, merlin_db: db } as unknown as AppBindings;
  async function request(path: string, body?: unknown, method = "POST") {
    const response = await app.request(`http://localhost/panel-api/custom-games/upload/${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }, env);
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() as any : await response.text() };
  }
  return { db, bucket, app, env, request, close: () => db.close() };
}

async function createSession(h: ReturnType<typeof harness>, count: number) {
  const result = await h.request("sessions", { gameId: GAME_ID, fingerprint: "c".repeat(64), planVersion: 2 });
  expect(result.status).toBe(201);
  const sessionId = result.body.sessionId as string;
  const bundles = Math.ceil(count / 3000);
  for (let bundle = 0; bundle < bundles; bundle++) {
    const clientId = `bundle-${bundle}`;
    const key = `${GAME_ID}/files/${String(bundle + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const checkpoint = { clientId, key, filename: "bundle.zip", sizeBytes: 1, sha256: OBJECT_SHA,
      completed: true, etag: `object-etag-${bundle}`, createdAt: Date.now(), state: "completed" };
    await h.bucket.put(`_upload-sessions/${sessionId}/objects/${clientId}.json`, JSON.stringify(checkpoint));
    await h.bucket.put(key, new Uint8Array([0]), { customMetadata: { uploadSessionId: sessionId, clientId } });
    // The fake R2 ETag is replaced with the checkpoint ETag so the route checks
    // the exact immutable upload reservation as it does in Workers.
    const stored = h.bucket.objects.get(key)!;
    stored.etag = checkpoint.etag;
  }
  return sessionId;
}

function* metadataBatches(count: number) {
  let global = 0;
  const bundleCount = Math.ceil(count / 3000);
  for (let bundle = 0; bundle < bundleCount; bundle++) {
    const membersInBundle = Math.min(3000, count - global);
    const fragmentCount = Math.ceil(membersInBundle / 400);
    const key = `${GAME_ID}/files/${String(bundle + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
      const files = [];
      const end = Math.min(membersInBundle, (fragmentIndex + 1) * 400);
      for (; global < bundle * 3000 + end; global++) {
        files.push({ path: `romfs/levels/level_${String(Math.floor(global / 1000)).padStart(4, "0")}/asset_${String(global).padStart(6, "0")}.bin`,
          sizeBytes: 1, sha256: FILE_SHA });
      }
      yield { kind: "bundle", clientId: `bundle-${bundle}`, key, sizeBytes: 1, sha256: OBJECT_SHA,
        fragmentIndex, fragmentCount, files };
    }
  }
}

async function streamPathCount(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = ""; let count = 0; let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = carry + decoder.decode(chunk.value, { stream: true });
    totalBytes += chunk.value.byteLength;
    count += (text.match(/"path":/g) || []).length;
  carry = text.slice(-6);
  }
  const tail = carry + decoder.decode();
  count += (tail.match(/"path":/g) || []).length;
  return { count, totalBytes };
}

describe("bounded folder metadata finalization", () => {
  const opened: ReturnType<typeof harness>[] = [];
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { for (const h of opened.splice(0)) h.close(); });

  for (const count of [277_000, 500_000]) {
    it(`sends, finalizes, streams and cleans a ${count.toLocaleString()}-file synthetic folder`, async () => {
      const h = harness(); opened.push(h);
      const startedAt = performance.now();
      const startMemory = process.memoryUsage();
      let peakHeapBytes = startMemory.heapUsed;
      let peakRssBytes = startMemory.rss;
      const sampleMemory = () => {
        const memory = process.memoryUsage();
        peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
      };
      const sessionId = await createSession(h, count);
      let batch: any[] = [];
      let batchIndex = 0;
      let totalBytes = 0;
      let actualPaths = 0;
      const send = async () => {
        const result = await h.request(`sessions/${sessionId}/metadata/batches/${batchIndex}`, {
          manifestId: MANIFEST_ID, entries: batch,
        });
        expect(result.status).toBe(200);
        totalBytes += new TextEncoder().encode(JSON.stringify({ manifestId: MANIFEST_ID, entries: batch })).byteLength;
        actualPaths += batch.reduce((sum, entry) => sum + entry.files.length, 0);
        batchIndex++; batch = [];
        sampleMemory();
      };
      for (const entry of metadataBatches(count)) {
        batch.push(entry);
        if (batch.length === 1) await send();
      }
      expect(actualPaths).toBe(count);
      const final = await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: batchIndex });
      expect(final.status).toBe(200);
      let outcome = final.body;
      let finalizationRequests = 1;
      let polls = 0;
      while (outcome.status === "processing") {
        expect(polls++).toBeLessThan(batchIndex + 2);
        const next = await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: batchIndex });
        finalizationRequests++;
        expect([200, 201]).toContain(next.status);
        outcome = next.body;
        sampleMemory();
      }
      expect(outcome).toMatchObject({ success: true, status: "complete", key: `${GAME_ID}/manifests/${MANIFEST_ID}.json`,
        sizeBytes: count, fileCount: count, packageType: "folder" });
      const index = await readShardedFolderIndex(h.env, outcome.key);
      expect(index).not.toBeNull();
      expect(Object.keys(index!.objects)).toHaveLength(Math.ceil(count / 3000));
      expect(index!.parts).toHaveLength(batchIndex);
      h.bucket.get.mockClear();
      const manifestResult = await streamPathCount(streamShardedFolderManifest(h.env, index!, GAME_ID, outcome.key));
      expect(h.bucket.get.mock.calls.map(([key]) => key)).toEqual(index!.parts.map(part => part.key));
      h.bucket.get.mockClear();
      const integrityResult = await streamPathCount(streamShardedIntegrityManifest(h.env, index!, GAME_ID, outcome.key));
      expect(h.bucket.get.mock.calls.map(([key]) => key)).toEqual(index!.parts.map(part => part.key));
      expect(manifestResult.count).toBe(count);
      expect(integrityResult.count).toBe(count);
      expect(manifestResult.totalBytes).toBeGreaterThan(totalBytes * 0.5);
      expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_files").get()?.count).toBe(0);
      expect(h.db.sqlite.prepare("SELECT status FROM custom_game_metadata_sessions WHERE session_id=?").get(sessionId)?.status).toBe("finalized");
      expect([...h.bucket.objects.keys()].some(key => key.startsWith(`_upload-sessions/${sessionId}/metadata/`))).toBe(false);
      const replay = await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: batchIndex });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "complete", key: outcome.key, sizeBytes: count });
      sampleMemory();
      const endMemory = process.memoryUsage();
      process.stderr.write(`[large-folder-poc] ${JSON.stringify({ syntheticFiles: count, metadataBatches: batchIndex,
        finalizationRequests, metadataBytes: totalBytes,
        elapsedMs: Math.round(performance.now() - startedAt), heapStartBytes: startMemory.heapUsed,
        heapEndBytes: endMemory.heapUsed, sampledPeakHeapBytes: peakHeapBytes, rssEndBytes: endMemory.rss,
        sampledPeakRssBytes: peakRssBytes, runtime: "node-22 + SQLite/D1-compatible harness" })}\n`);
    }, 180_000);
  }

  it("rejects a missing batch, repairs identical replay, and rejects path collisions across batches", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 3001);
    const entry = (path: string, n: number) => ({ kind: "bundle", clientId: `bundle-${n}`, key:
      `${GAME_ID}/files/${String(n + 1).padStart(8, "0")}-1111-4111-8111-111111111111`, sizeBytes: 1,
      sha256: OBJECT_SHA, fragmentIndex: 0, fragmentCount: 1,
      files: [{ path, sizeBytes: 1, sha256: FILE_SHA }] });
    const first = { manifestId: MANIFEST_ID, entries: [entry("folder", 0)] };
    expect((await h.request(`sessions/${sessionId}/metadata/batches/0`, first)).status).toBe(200);
    expect((await h.request(`sessions/${sessionId}/metadata/batches/0`, first)).status).toBe(200);
    const batchKey = `_upload-sessions/${sessionId}/metadata/${MANIFEST_ID}/000000.json`;
    await h.bucket.delete(batchKey);
    expect((await h.request(`sessions/${sessionId}/metadata/batches/0`, first)).status).toBe(200);
    expect(await h.bucket.get(batchKey)).not.toBeNull();
    const missing = await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: 2 });
    expect(missing.status).toBe(409);
    const conflict = await h.request(`sessions/${sessionId}/metadata/batches/1`, { manifestId: MANIFEST_ID,
      entries: [entry("folder/child.bin", 1)] });
    expect(conflict.status).toBe(409);
  });

  it("resumes after finalization interruption and repairs an identical batch whose R2 object disappeared", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 12_001);
    const payloads: { manifestId: string; entries: any[] }[] = [];
    for (const entries of metadataBatches(12_001)) {
      const payload = { manifestId: MANIFEST_ID, entries: [entries] };
      payloads.push(payload);
      const response = await h.request(`sessions/${sessionId}/metadata/batches/${payloads.length - 1}`, payload);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect(payloads.length).toBeGreaterThan(32);
    const first = await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: payloads.length });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "processing", processedBatches: 32, batchCount: payloads.length });
    const recoveryIndex = 32;
    const recoveryKey = `_upload-sessions/${sessionId}/metadata/${MANIFEST_ID}/${String(recoveryIndex).padStart(6, "0")}.json`;
    await h.bucket.delete(recoveryKey);
    expect((await h.request(`sessions/${sessionId}/metadata/batches/${recoveryIndex}`, payloads[recoveryIndex])).status).toBe(200);
    let final = first.body;
    while (final.status === "processing") {
      final = (await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: payloads.length })).body;
    }
    expect(final).toMatchObject({ status: "complete", key: `${GAME_ID}/manifests/${MANIFEST_ID}.json`, fileCount: 12_001 });
    expect((await h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: payloads.length })).body.status).toBe("complete");
  });

  it("removes temporary metadata and orphaned manifest parts when an upload is cancelled", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 1);
    const payload = { manifestId: MANIFEST_ID, entries: [metadataBatches(1).next().value] };
    const submitted = await h.request(`sessions/${sessionId}/metadata/batches/0`, payload);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const response = await h.request(`sessions/${sessionId}/cancel`);
    expect(response.status).toBe(200);
    expect(h.bucket.objects.has(`_upload-sessions/${sessionId}/metadata/${MANIFEST_ID}/000000.json`)).toBe(false);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_batches WHERE session_id=?").get(sessionId)?.count).toBe(0);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_files WHERE session_id=?").get(sessionId)?.count).toBe(0);
    expect([...h.bucket.objects.keys()].some(key => key.startsWith(`${GAME_ID}/manifest-parts/${MANIFEST_ID}/`))).toBe(false);
  });

  it("fences a metadata batch that finishes its R2 write after cancellation cleanup", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 1);
    const payload = { manifestId: MANIFEST_ID, entries: [metadataBatches(1).next().value] };
    const metadataKey = `_upload-sessions/${sessionId}/metadata/${MANIFEST_ID}/000000.json`;
    const put = h.bucket.put.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const inWrite = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.bucket.put.mockImplementation(async (key, body, options) => {
      if (key === metadataKey) { entered(); await gate; }
      return put(key, body, options);
    });

    const upload = h.request(`sessions/${sessionId}/metadata/batches/0`, payload);
    await inWrite;
    const cancel = await h.request(`sessions/${sessionId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    release();
    expect((await upload).status).toBe(409);
    expect(h.bucket.objects.has(metadataKey)).toBe(false);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_batches WHERE session_id=?").get(sessionId)?.count).toBe(0);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_files WHERE session_id=?").get(sessionId)?.count).toBe(0);
    expect(h.db.sqlite.prepare("SELECT status FROM custom_game_metadata_sessions WHERE session_id=?").get(sessionId)?.status).toBe("cancelled");
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM custom_game_metadata_cancelled_sessions WHERE session_id=?").get(sessionId)?.count).toBe(1);
    expect(() => h.db.sqlite.prepare(`INSERT INTO custom_game_metadata_batches(session_id,manifest_id,batch_index,sha256)
      VALUES(?,?,?,?)`).run(sessionId, MANIFEST_ID, 1, "d".repeat(64))).toThrow(/metadata_session_closed/);
  });

  it("cancels a stale finalizer atomically and removes an R2 part written after cleanup", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 1);
    h.db.sqlite.exec("CREATE TABLE custom_games(id TEXT, archive_key TEXT); CREATE TABLE custom_game_versions(game_id TEXT, archive_key TEXT, status TEXT);");
    const payload = { manifestId: MANIFEST_ID, entries: [metadataBatches(1).next().value] };
    expect((await h.request(`sessions/${sessionId}/metadata/batches/0`, payload)).status).toBe(200);
    const partKey = `${GAME_ID}/manifest-parts/${MANIFEST_ID}/000000.json`;
    const put = h.bucket.put.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const inWrite = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.bucket.put.mockImplementation(async (key, body, options) => {
      if (key === partKey) { entered(); await gate; }
      return put(key, body, options);
    });

    const finalization = h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: 1 });
    await inWrite;
    h.db.sqlite.prepare("UPDATE custom_game_metadata_sessions SET updated_at=? WHERE session_id=?")
      .run(Date.now() - 11 * 60_000, sessionId);
    const cancel = await h.request(`sessions/${sessionId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    release();
    expect((await finalization).status).toBe(409);
    expect(h.bucket.objects.has(partKey)).toBe(false);
    expect(h.bucket.objects.has(`${GAME_ID}/manifests/${MANIFEST_ID}.json`)).toBe(false);
    expect(h.db.sqlite.prepare("SELECT status FROM custom_game_metadata_sessions WHERE session_id=?").get(sessionId)?.status).toBe("cancelled");
  });

  it("does not allow cancellation after the atomic publishing claim", async () => {
    const h = harness(); opened.push(h);
    const sessionId = await createSession(h, 1);
    const payload = { manifestId: MANIFEST_ID, entries: [metadataBatches(1).next().value] };
    expect((await h.request(`sessions/${sessionId}/metadata/batches/0`, payload)).status).toBe(200);
    const manifestKey = `${GAME_ID}/manifests/${MANIFEST_ID}.json`;
    const put = h.bucket.put.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const inWrite = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.bucket.put.mockImplementation(async (key, body, options) => {
      if (key === manifestKey) { entered(); await gate; }
      return put(key, body, options);
    });

    const finalization = h.request(`sessions/${sessionId}/metadata/complete`, { manifestId: MANIFEST_ID, batchCount: 1 });
    await inWrite;
    expect(h.db.sqlite.prepare("SELECT status FROM custom_game_metadata_sessions WHERE session_id=?").get(sessionId)?.status).toBe("publishing");
    const cancel = await h.request(`sessions/${sessionId}/cancel`);
    expect(cancel.status).toBe(409);
    release();
    expect((await finalization).status).toBe(201);
    expect(h.bucket.objects.has(manifestKey)).toBe(true);
  });
});
