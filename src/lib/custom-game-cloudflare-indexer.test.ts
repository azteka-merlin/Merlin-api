import { describe, expect, it, vi } from "vitest";
import type { AppBindings, AppContext } from "../types";
import { consumeCloudflareIntegrityBatch, processCloudflareIntegrityMessage, type IntegrityQueueMessage } from "./custom-game-cloudflare-indexer";
import { dispatchPendingIntegrityQueue, enqueueGameIntegrity, integrityManifestKey, readJob, writeJob,
  type IntegrityDependencies, type IntegrityFile, type IntegrityGame, type IntegrityJob } from "./custom-game-integrity";

const GAME = "00000000-0000-4000-8000-000000000011";
const ARCHIVE = `${GAME}/archives/00000000-0000-4000-8000-000000000012.zip`;
const SHA = "a".repeat(64);
type Stored = { value: string | Uint8Array; etag: string; uploaded: Date; customMetadata: Record<string, string> };

class Bucket {
  objects = new Map<string, Stored>();
  next = 0;
  manifestFailures = 0;
  writes: string[] = [];
  async put(key: string, value: string | Uint8Array, options: any = {}) {
    const previous = this.objects.get(key);
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
    if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
    if (key.includes("/integrity/") && this.manifestFailures > 0) {
      this.manifestFailures--;
      throw new Error("Transient publication failure");
    }
    const stored = { value, etag: `etag-${++this.next}`, uploaded: new Date(), customMetadata: options.customMetadata || {} };
    this.objects.set(key, stored);
    this.writes.push(key);
    return this.metadata(key, stored);
  }
  metadata(key: string, stored: Stored) {
    return { key, etag: stored.etag, httpEtag: `"${stored.etag}"`, uploaded: stored.uploaded,
      size: typeof stored.value === "string" ? new TextEncoder().encode(stored.value).byteLength : stored.value.byteLength,
      customMetadata: { ...stored.customMetadata } };
  }
  async head(key: string) { const stored = this.objects.get(key); return stored ? this.metadata(key, stored) : null; }
  async get(key: string, options: any = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const metadata = this.metadata(key, stored);
    if (options.onlyIf?.etagMatches && stored.etag !== options.onlyIf.etagMatches) return metadata;
    let bytes = typeof stored.value === "string" ? new TextEncoder().encode(stored.value) : stored.value;
    if (options.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
    return { ...metadata, body: new Blob([bytes]).stream(), json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      text: async () => new TextDecoder().decode(bytes) };
  }
  async list({ prefix = "", cursor, limit = 1000 }: any = {}) {
    const entries = [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    const offset = Number(cursor || 0);
    return { objects: entries.slice(offset, offset + limit).map(([key, value]) => this.metadata(key, value)),
      truncated: offset + limit < entries.length, cursor: offset + limit < entries.length ? String(offset + limit) : undefined };
  }
}

function validatePath(value: unknown) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").some(part => !part || part === ".." || part === ".")) throw new Error("Invalid path");
  return value;
}
function validateSha(value: unknown) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid SHA"); return value; }
function message(body: IntegrityQueueMessage, attempts = 1) {
  return { body: structuredClone(body), attempts, id: crypto.randomUUID(), timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
}
function batch(item: ReturnType<typeof message>) { return { queue: "test-integrity", messages: [item], ackAll: vi.fn(), retryAll: vi.fn() } as any; }

async function harness({ folder = false } = {}) {
  const bucket = new Bucket();
  const game: IntegrityGame = { id: GAME, name: "Queue Game", archive_key: folder ? `${GAME}/manifests/00000000-0000-4000-8000-000000000013.json` : ARCHIVE,
    archive_size: folder ? 7 : 256, package_type: folder ? "folder" : "zip", published: 1 };
  const results: IntegrityFile[] = [
    { path: "game.exe", sizeBytes: 3, sha256: SHA, ...(!folder ? { zip: { offset: 40, compressedSize: 3, method: 0 as const, crc32: 123 } } : {}) },
    { path: "data/game.pak", sizeBytes: 4, sha256: SHA, ...(!folder ? { zip: { offset: 90, compressedSize: 4, method: 0 as const, crc32: 456 } } : {}) },
  ];
  const planEntries = results.map(({ sha256: _, ...entry }) => entry);
  const folderManifest = { version: 1, totalSizeBytes: 7, files: planEntries.map(entry => ({ ...entry, key: `${GAME}/files/${entry.path}` })) };
  const sent: IntegrityQueueMessage[] = [];
  const send = vi.fn(async (value: IntegrityQueueMessage) => { sent.push(structuredClone(value)); });
  const env = { ENVIRONMENT: "production", CUSTOM_GAMES: bucket, CUSTOM_GAME_INDEX_QUEUE: { send } } as unknown as AppBindings;
  const context = { env } as AppContext;
  const deps: IntegrityDependencies = { findGame: async () => game, loadFolderManifest: async () => folderManifest,
    validateGameFilePath: validatePath, validateSha256: validateSha };
  const planZip = vi.fn(async () => ({ totalSizeBytes: 7, files: planEntries as any }));
  const hashZip = vi.fn(async (_bucket: unknown, _key: unknown, _etag: unknown, _size: unknown, entry: any) => results.find(file => file.path === entry.path)!);
  const hashFolder = vi.fn(async (_bucket: unknown, entry: any) => results.find(file => file.path === entry.path)!);
  const options = { planZip: planZip as any, hashZip: hashZip as any, hashFolder: hashFolder as any };
  await bucket.put(game.archive_key, folder ? JSON.stringify(folderManifest) : new Uint8Array(256));
  const enqueue = (force = false) => enqueueGameIntegrity(context, game, deps, { force });
  await enqueue();
  const body = sent[0]!;
  const state = async () => (await readJob(env, body.jobId))!.job;
  const patch = async (changes: Partial<IntegrityJob>) => {
    const record = (await readJob(env, body.jobId))!;
    await writeJob(env, { ...record.job, ...changes }, record.etag);
  };
  const manifest = async () => {
    const object = await bucket.get(await integrityManifestKey(game.id, game.archive_key));
    return object && "json" in object ? object : null;
  };
  return { bucket, game, results, env, deps, sent, send, body, options, planZip, hashZip, hashFolder, state, patch, manifest, enqueue };
}

describe("Cloudflare custom game index orchestration", () => {
  it("checkpoints one file and continues in a new invocation without hashing it twice", async () => {
    const h = await harness();
    await processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, { ...h.options, maxFiles: 1 });
    expect(await h.state()).toMatchObject({ status: "queued", phase: "indexing", queueCursor: 1, processedFiles: 1, processedBytes: 3 });
    expect(await h.manifest()).toBeNull();
    expect(h.sent).toHaveLength(2);
    await processCloudflareIntegrityMessage(h.env, h.sent[1]!, h.deps, 1, { ...h.options, maxFiles: 1 });
    expect(await h.state()).toMatchObject({ status: "completed", phase: "completed", queueCursor: 2, processedFiles: 2, processedBytes: 7 });
    expect(h.planZip).toHaveBeenCalledTimes(1);
    expect(h.hashZip).toHaveBeenCalledTimes(2);
    expect(await (await h.manifest())!.json()).toMatchObject({ gameId: GAME, totalSizeBytes: 7, files: h.results });
  });

  it("claims only once when concurrent duplicate messages arrive and ignores completed redelivery", async () => {
    const h = await harness();
    await Promise.all([
      processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options),
      processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options),
    ]);
    await processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options);
    expect(h.hashZip).toHaveBeenCalledTimes(2);
    expect(h.planZip).toHaveBeenCalledTimes(1);
    expect(await h.state()).toMatchObject({ status: "completed" });
    expect(h.bucket.writes.filter(key => key.includes("/integrity/"))).toHaveLength(1);
  });

  it("ignores malformed messages and an old generation after reindexing", async () => {
    const h = await harness();
    await h.patch({ status: "cancelled", phase: "cancelled" });
    await h.enqueue();
    const current = h.sent.at(-1)!;
    expect(current.generation).not.toBe(h.body.generation);
    await processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options);
    await processCloudflareIntegrityMessage(h.env, { jobId: "invalid", generation: "invalid" }, h.deps, 1, h.options);
    expect(h.hashZip).not.toHaveBeenCalled();
    expect(await h.state()).toMatchObject({ status: "queued", queueGeneration: current.generation, queueCursor: 0 });
  });

  it("retries source changes, then marks failure without publishing or falsely acknowledging success", async () => {
    const h = await harness();
    await h.bucket.put(h.game.archive_key, new Uint8Array(256));
    const first = message(h.body, 1);
    await consumeCloudflareIntegrityBatch(batch(first), h.env, h.deps, h.options);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(await h.state()).toMatchObject({ status: "queued" });
    const last = message(h.body, 4);
    await consumeCloudflareIntegrityBatch(batch(last), h.env, h.deps, h.options);
    expect(await h.state()).toMatchObject({ status: "failed", phase: "failed" });
    expect(last.retry).toHaveBeenCalled();
    expect(last.ack).not.toHaveBeenCalled();
    expect(h.hashZip).not.toHaveBeenCalled();
    expect(await h.manifest()).toBeNull();
  });

  it("keeps cancellation final when it happens during a hash", async () => {
    const h = await harness();
    h.hashZip.mockImplementationOnce(async () => {
      await h.patch({ status: "cancelled", phase: "cancelled" });
      return h.results[0]!;
    });
    const item = message(h.body);
    await consumeCloudflareIntegrityBatch(batch(item), h.env, h.deps, { ...h.options, maxFiles: 1 });
    expect(await h.state()).toMatchObject({ status: "cancelled", phase: "cancelled", queueCursor: 0 });
    expect(await h.manifest()).toBeNull();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("retains completed file checkpoints when continuation send fails and cron repairs dispatch", async () => {
    const h = await harness();
    h.send.mockRejectedValueOnce(new Error("Queue temporarily unavailable"));
    const item = message(h.body);
    await consumeCloudflareIntegrityBatch(batch(item), h.env, h.deps, { ...h.options, maxFiles: 1 });
    expect(await h.state()).toMatchObject({ status: "queued", queueCursor: 1, processedFiles: 1 });
    await dispatchPendingIntegrityQueue(h.env);
    expect(h.sent).toHaveLength(2);
    await processCloudflareIntegrityMessage(h.env, h.sent.at(-1)!, h.deps, 1, h.options);
    expect(await h.state()).toMatchObject({ status: "completed" });
    expect(h.planZip).toHaveBeenCalledTimes(1);
    expect(h.hashZip).toHaveBeenCalledTimes(2);
  });

  it("keeps the R2 journal when the first send fails and cron can submit it later", async () => {
    const h = await harness();
    await h.patch({ status: "cancelled", phase: "cancelled" });
    h.send.mockRejectedValueOnce(new Error("Queue temporarily unavailable"));
    expect(await h.enqueue()).toMatchObject({ queued: true });
    const queued = await h.state();
    expect(queued).toMatchObject({ status: "queued", queueCursor: 0 });
    await dispatchPendingIntegrityQueue(h.env);
    expect(h.sent.at(-1)).toEqual({ jobId: h.body.jobId, generation: queued.queueGeneration });
    await processCloudflareIntegrityMessage(h.env, h.sent.at(-1)!, h.deps, 1, h.options);
    expect(await h.state()).toMatchObject({ status: "completed" });
  });

  it("recovers failed publication from saved results without downloading files again", async () => {
    const h = await harness();
    h.bucket.manifestFailures = 1;
    const item = message(h.body);
    await consumeCloudflareIntegrityBatch(batch(item), h.env, h.deps, h.options);
    expect(item.retry).toHaveBeenCalled();
    expect(await h.state()).toMatchObject({ status: "queued", queueCursor: 2, processedFiles: 2 });
    expect(await h.manifest()).toBeNull();
    await processCloudflareIntegrityMessage(h.env, h.body, h.deps, 2, h.options);
    expect(await h.state()).toMatchObject({ status: "completed", phase: "completed" });
    expect(h.hashZip).toHaveBeenCalledTimes(2);
    expect(h.planZip).toHaveBeenCalledTimes(1);
    expect(await h.manifest()).not.toBeNull();
  });

  it("does not let an older failed invocation overwrite a replacement lease", async () => {
    const h = await harness();
    const replacement = crypto.randomUUID();
    h.hashZip.mockImplementationOnce(async () => {
      await h.patch({ leaseToken: replacement, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
      throw new Error("Old invocation failed late");
    });
    await consumeCloudflareIntegrityBatch(batch(message(h.body)), h.env, h.deps, h.options);
    expect(await h.state()).toMatchObject({ status: "processing", phase: "indexing", leaseToken: replacement });
    expect(await h.manifest()).toBeNull();
  });

  it("does not let an older failed invocation rewrite a newly enqueued generation", async () => {
    const h = await harness();
    let replacement = "";
    h.hashZip.mockImplementationOnce(async () => {
      await h.patch({ status: "cancelled", phase: "cancelled" });
      await h.enqueue();
      replacement = (await h.state()).queueGeneration!;
      throw new Error("Old generation failed late");
    });
    await consumeCloudflareIntegrityBatch(batch(message(h.body)), h.env, h.deps, h.options);
    expect(replacement).not.toBe(h.body.generation);
    expect(await h.state()).toMatchObject({ status: "queued", phase: "queued", queueGeneration: replacement, queueCursor: 0 });
    expect(await h.manifest()).toBeNull();
  });

  it("refuses to publish if source changes while a file is being hashed", async () => {
    const h = await harness();
    h.hashZip.mockImplementationOnce(async () => {
      await h.bucket.put(h.game.archive_key, new Uint8Array(256));
      return h.results[0]!;
    });
    await consumeCloudflareIntegrityBatch(batch(message(h.body)), h.env, h.deps, h.options);
    expect(await h.state()).toMatchObject({ status: "queued" });
    expect(await h.manifest()).toBeNull();
  });

  it("indexes a legacy folder using the same queue without invoking ZIP processing", async () => {
    const h = await harness({ folder: true });
    await processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options);
    expect(await h.state()).toMatchObject({ status: "completed", processedBytes: 7, processedFiles: 2 });
    expect(h.hashFolder).toHaveBeenCalledTimes(2);
    expect(h.hashZip).not.toHaveBeenCalled();
    expect(h.planZip).not.toHaveBeenCalled();
    expect(await (await h.manifest())!.json()).toMatchObject({ files: h.results, totalSizeBytes: 7 });
  });

  it("does not redispatch failed jobs, but does redispatch expired processing leases", async () => {
    const h = await harness();
    await h.patch({ status: "processing", phase: "indexing", leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(), attempts: 1 });
    await dispatchPendingIntegrityQueue(h.env);
    expect(h.sent).toHaveLength(2);
    await h.patch({ status: "failed", phase: "failed" });
    await dispatchPendingIntegrityQueue(h.env);
    expect(h.sent).toHaveLength(2);
  });

  it("bounds hard execution deaths across new cron messages instead of resetting their attempts", async () => {
    const h = await harness();
    h.hashZip.mockRejectedValue(new Error("Simulated hard execution death before a checkpoint"));
    for (let attempt = 1; attempt <= 4; attempt++) {
      // A CPU/wall timeout skips the batch catch entirely. Each cron dispatch is
      // a new Queue message whose platform attempt counter starts at one.
      await expect(processCloudflareIntegrityMessage(h.env, h.body, h.deps, 1, h.options)).rejects.toThrow("hard execution death");
      expect(await h.state()).toMatchObject({ status: "processing", queueCursor: 0, attempts: attempt });
      await h.patch({ leaseExpiresAt: new Date(Date.now() - 1).toISOString() });
      await dispatchPendingIntegrityQueue(h.env);
    }
    expect(await h.state()).toMatchObject({ status: "failed", phase: "failed", attempts: 4 });
    expect(h.sent).toHaveLength(4);
    expect(await h.manifest()).toBeNull();
  });

  it("retries transient R2 rate and availability errors with backoff while preserving the CAS", async () => {
    const h = await harness();
    const record = (await readJob(h.env, h.body.jobId))!;
    const put = vi.spyOn(h.bucket, "put")
      .mockRejectedValueOnce(Object.assign(new Error("R2 rate limited"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("R2 temporarily unavailable"), { statusCode: 503 }));
    vi.useFakeTimers();
    try {
      const pending = writeJob(h.env, { ...record.job, phase: "indexing" }, record.etag);
      await vi.advanceTimersByTimeAsync(1099);
      expect(put).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(put).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2199);
      expect(put).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).not.toBeNull();
      expect(put).toHaveBeenCalledTimes(3);
      for (const call of put.mock.calls) expect(call[2]?.onlyIf).toEqual({ etagMatches: record.etag });
      expect(await h.state()).toMatchObject({ status: "queued", phase: "indexing", queueGeneration: h.body.generation });
    } finally {
      vi.useRealTimers();
      put.mockRestore();
    }
  });

  it("does not overwrite cancellation or a newer generation that wins during an R2 backoff", async () => {
    for (const replacement of ["cancelled", "generation"] as const) {
      const h = await harness();
      const record = (await readJob(h.env, h.body.jobId))!;
      const put = vi.spyOn(h.bucket, "put").mockRejectedValueOnce(Object.assign(new Error("SlowDown"), { status: 429 }));
      vi.useFakeTimers();
      try {
        const pending = writeJob(h.env, { ...record.job, status: "processing", phase: "indexing" }, record.etag);
        await vi.advanceTimersByTimeAsync(0);
        expect(put).toHaveBeenCalledTimes(1);
        const winning: Partial<IntegrityJob> = replacement === "cancelled"
          ? { status: "cancelled", phase: "cancelled" }
          : { status: "queued", phase: "queued", queueGeneration: crypto.randomUUID(), queueCursor: 0 };
        await h.patch(winning);
        const winner = (await readJob(h.env, h.body.jobId))!;
        expect(winner.etag).not.toBe(record.etag);
        await vi.advanceTimersByTimeAsync(1100);
        expect(await pending).toBeNull();
        expect(await h.state()).toMatchObject(winning);
        expect((await readJob(h.env, h.body.jobId))!.etag).toBe(winner.etag);
        expect(put.mock.calls.at(-1)![2]?.onlyIf).toEqual({ etagMatches: record.etag });
      } finally {
        vi.useRealTimers();
        put.mockRestore();
      }
    }
  });
});
