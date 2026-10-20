import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { enqueueGameIntegrity, getIntegrityManifest, integrityJobId, integrityManifestKey,
  registerCustomGameIntegrityRoutes, validateIntegrityManifest, type IntegrityDependencies, type IntegrityGame } from "./custom-game-integrity";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn(async () => ({})) }));
vi.mock("./launcher-auth", () => ({ requireGoldLauncherLicense: vi.fn(async () => ({})) }));

const GAME = "00000000-0000-4000-8000-000000000001";
const ZIP = `${GAME}/archives/00000000-0000-4000-8000-000000000002.zip`;
const FOLDER = `${GAME}/manifests/00000000-0000-4000-8000-000000000003.json`;
const SECRET = "runner-secret-that-stays-private";
const SHA = "a".repeat(64);
type Stored = { value: string | Uint8Array; etag: string; uploaded: Date; customMetadata: Record<string, string> };

class MemoryBucket {
  objects = new Map<string, Stored>();
  next = 0;
  gets: string[] = [];
  async put(key: string, value: string | Uint8Array, options: any = {}) {
    const previous = this.objects.get(key);
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== previous?.etag) return null;
    if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
    const stored = { value, etag: `etag-${++this.next}`, uploaded: new Date(), customMetadata: options.customMetadata || {} };
    this.objects.set(key, stored);
    return this.metadata(key, stored);
  }
  metadata(key: string, stored: Stored) {
    return { key, etag: stored.etag, httpEtag: `"${stored.etag}"`, size: new TextEncoder().encode(typeof stored.value === "string" ? stored.value : "").length || (stored.value as Uint8Array).byteLength || 0,
      uploaded: stored.uploaded, customMetadata: { ...stored.customMetadata } };
  }
  async head(key: string) { const stored = this.objects.get(key); return stored ? this.metadata(key, stored) : null; }
  async get(key: string, options: any = {}) {
    this.gets.push(key);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const metadata = this.metadata(key, stored);
    if (options.onlyIf?.etagMatches && stored.etag !== options.onlyIf.etagMatches) return metadata;
    let bytes = typeof stored.value === "string" ? new TextEncoder().encode(stored.value) : stored.value;
    if (options.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
    return { ...metadata, body: new Blob([bytes]).stream(), json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      text: async () => new TextDecoder().decode(bytes) };
  }
  async list({ prefix = "", include, cursor, limit = 1000 }: any) {
    const entries = [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    const offset = Number(cursor || 0);
    return { objects: entries.slice(offset, offset + limit).map(([key, value]) => this.metadata(key, value)),
      truncated: entries.length > offset + limit, cursor: entries.length > offset + limit ? String(offset + limit) : undefined };
  }
  async patchJob(id: string, patch: Record<string, unknown>) {
    const key = `_integrity-jobs/production/${id}.json`;
    const stored = this.objects.get(key)!;
    const job = { ...JSON.parse(String(stored.value)), ...patch };
    const visible = { ...JSON.parse(stored.customMetadata.job!), ...patch };
    delete visible.leaseToken;
    await this.put(key, JSON.stringify(job), { customMetadata: { job: JSON.stringify(visible) } });
  }
}

function validPath(value: unknown) {
  const path = String(value || "").replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error("Invalid path");
  return path;
}
function validSha(value: unknown) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid SHA"); return value; }

function harness({ packageType = "zip", folderVersion = 1, folderHash = false, historical = false } = {}) {
  const bucket = new MemoryBucket();
  const game: IntegrityGame = { id: GAME, name: "Example Game", archive_key: packageType === "folder" ? FOLDER : ZIP,
    archive_size: packageType === "folder" ? 3 : 128, package_type: packageType as "zip" | "folder", published: 1 };
  const folder = { version: folderVersion, totalSizeBytes: 3, files: [{ path: "main.exe", key: `${GAME}/files/00000000-0000-4000-8000-000000000004`,
    sizeBytes: 3, ...(folderHash ? { sha256: SHA } : {}) }] };
  const deps: IntegrityDependencies = { findGame: async (_c, id) => id === GAME ? game : null,
    loadFolderManifest: async () => folder, validateGameFilePath: validPath, validateSha256: validSha,
    ...(historical ? { isPackageAvailable: async () => true, resolveIntegrityPackage: async (_c: AppContext, _game: IntegrityGame, archiveKey: string) => ({ ...game, archive_key: archiveKey }) } : {}) };
  const env = { CUSTOM_GAMES: bucket, CUSTOM_GAME_INDEXER_SECRET: SECRET,
    merlin_db: { prepare: () => ({ all: async () => ({ results: [game] }) }) } } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>();
  registerCustomGameIntegrityRoutes(app, deps);
  let context: AppContext;
  app.get("/context", c => { context = c; return c.text("ok"); });
  const init = async () => {
    await bucket.put(game.archive_key, packageType === "folder" ? JSON.stringify(folder) : new Uint8Array(128));
    if (packageType === "folder") await bucket.put(folder.files[0]!.key, new Uint8Array([1, 2, 3]));
    await app.request("https://localhost/context", {}, env);
  };
  const request = async (route: string, body?: unknown, options: RequestInit = {}) => {
    return app.request(`https://localhost${route}`, { method: body === undefined ? "GET" : "POST", ...options,
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...(options.headers || {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  };
  const enqueue = (force = false) => enqueueGameIntegrity(context!, game, deps, { force });
  const claim = async () => (await (await request("/internal/custom-game-indexing/claim", {})).json()) as any;
  return { app, bucket, game, folder, env, deps, request, init, enqueue, claim, getContext: () => context! };
}

function resultManifest(game: IntegrityGame, files?: unknown[]) {
  return { version: 1, gameId: game.id, archiveKey: game.archive_key, totalSizeBytes: 3,
    files: files || [{ path: "main.exe", sizeBytes: 3, sha256: SHA,
      ...((game.package_type || "zip") === "zip" ? { zip: { offset: 38, compressedSize: 3, method: 0, crc32: 123 } } : {}) }] };
}

describe("custom game integrity index", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deduplicates queue insertion and atomically grants only one concurrent claim", async () => {
    const h = harness(); await h.init();
    const first = await h.enqueue(); const duplicate = await h.enqueue();
    expect(first.queued).toBe(true); expect(duplicate.queued).toBe(false);
    const claims = await Promise.all([h.claim(), h.claim()]);
    expect(claims.filter(claim => claim.job)).toHaveLength(1);
    const job = claims.find(claim => claim.job)!.job;
    expect(job.sourceSize).toBe(128); expect(job.sourceEtag).toBeTruthy(); expect(job.leaseToken).toBeTruthy();
    expect(Date.parse(job.leaseExpiresAt)).toBeGreaterThan(Date.now());
  });

  it("isolates staging claims and worker liveness from production in the shared bucket", async () => {
    const h = harness(); await h.init(); h.env.ENVIRONMENT = "production"; await h.enqueue();
    const stagingEnv = { ...h.env, ENVIRONMENT: "staging" as const };
    const stagingClaim = await h.app.request("https://localhost/internal/custom-game-indexing/claim", {
      method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: "{}",
    }, stagingEnv);
    expect((await stagingClaim.json() as any).job).toBeNull();
    const productionDashboard = await (await h.request("/panel-api/custom-games/indexing")).json() as any;
    expect(productionDashboard.summary.queued).toBe(1);
    expect(productionDashboard.workerLastSeenAt).toBeNull();
    expect(await h.bucket.head("_integrity-worker/staging/last-seen.json")).toBeTruthy();
    expect((await h.claim()).job).toBeTruthy();
  });

  it("derives complete folder hashes without reading game data or enqueueing a worker", async () => {
    const h = harness({ packageType: "folder", folderVersion: 3, folderHash: true }); await h.init();
    expect((await h.enqueue()).queued).toBe(false);
    const manifest = await getIntegrityManifest(h.getContext(), h.game, h.deps);
    expect(manifest?.files[0]?.sha256).toBe(SHA);
    expect(h.bucket.gets).not.toContain(h.folder.files[0]!.key);
    expect(await h.bucket.head(await integrityManifestKey(GAME, FOLDER))).toBeTruthy();
    expect((await h.claim()).job).toBeNull();
  });

  it("keeps secrets out of list metadata and the admin dashboard", async () => {
    const h = harness(); await h.init(); await h.enqueue();
    const { job } = await h.claim();
    const dashboard = await (await h.request("/panel-api/custom-games/indexing")).json() as any;
    expect(dashboard.summary.processing).toBe(1);
    expect(dashboard.games[0].indexStatus).toBe("processing");
    expect(dashboard.workerConfigured).toBe(true);
    expect(dashboard.workerLastSeenAt).toBeTruthy();
    expect(JSON.stringify(dashboard)).not.toContain(job.leaseToken);
    expect(JSON.stringify(dashboard)).not.toContain(SECRET);
    const listed = await h.bucket.list({ prefix: "_integrity-jobs/" });
    expect(JSON.stringify(listed)).not.toContain(job.leaseToken);
  });

  it("authenticates internal calls and bounds manifest request bodies", async () => {
    const h = harness(); await h.init();
    const denied = await h.request("/internal/custom-game-indexing/claim", {}, { headers: { authorization: "Bearer wrong" } });
    expect(denied.status).toBe(401);
    const oversized = await h.request(`/internal/custom-game-indexing/${"a".repeat(64)}/complete`, {}, { headers: { "content-length": String(17 * 1024 ** 2) } });
    expect(oversized.status).toBe(413);
    h.env.CUSTOM_GAME_INDEXER_SECRET = undefined;
    expect((await h.request("/internal/custom-game-indexing/claim", {})).status).toBe(503);
  });

  it.each([
    ["GET", "/internal/custom-game-indexing/status"],
    ["POST", "/internal/custom-game-indexing/enqueue"],
  ])("requires the service secret for %s %s", async (method, route) => {
    const h = harness(); await h.init();
    for (const authorization of [undefined, "Bearer wrong", "Basic ignored"]) {
      const headers = { "content-type": "application/json", ...(authorization ? { authorization } : {}) };
      const response = await h.app.request(`https://localhost${route}`, { method, headers,
        ...(method === "POST" ? { body: JSON.stringify({ mode: "missing" }) } : {}) }, h.env);
      expect(response.status).toBe(401);
    }
    expect(await h.bucket.list({ prefix: "_integrity-jobs/" })).toMatchObject({ objects: [] });
    h.env.CUSTOM_GAME_INDEXER_SECRET = undefined;
    expect((await h.request(route, method === "POST" ? { mode: "missing" } : undefined)).status).toBe(503);
    expect(requireAdminSession).not.toHaveBeenCalled();
  });

  it("enqueues and reports through service auth using the admin queue semantics without disclosing credentials", async () => {
    const h = harness(); await h.init();
    expect((await h.request("/internal/custom-game-indexing/enqueue", { mode: "invalid" })).status).toBe(400);
    expect((await h.request("/internal/custom-game-indexing/enqueue", { mode: "missing", gameId: "invalid" })).status).toBe(400);
    expect((await h.request("/internal/custom-game-indexing/enqueue", { mode: "missing", gameId: "00000000-0000-4000-8000-000000000099" })).status).toBe(404);
    const response = await h.request("/internal/custom-game-indexing/enqueue", { mode: "missing", gameId: GAME });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ success: true, queued: 1, skipped: 0 });
    expect(await (await h.request("/internal/custom-game-indexing/enqueue", { mode: "all" })).json())
      .toMatchObject({ success: true, queued: 0, skipped: 1 });
    const { job } = await h.claim();
    const status = await h.request("/internal/custom-game-indexing/status");
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    const dashboard = await status.json() as any;
    expect(dashboard.summary.processing).toBe(1);
    expect(dashboard.games[0].indexStatus).toBe("processing");
    expect(JSON.stringify(dashboard)).not.toContain(job.leaseToken);
    expect(JSON.stringify(dashboard)).not.toContain(SECRET);
    expect(requireAdminSession).not.toHaveBeenCalled();

    // Possession of a service credential must not substitute for admin or CSRF authentication.
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new HTTPException(401));
    expect((await h.request("/panel-api/custom-games/indexing")).status).toBe(401);
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new HTTPException(403));
    expect((await h.request("/panel-api/custom-games/indexing", { mode: "all" })).status).toBe(403);
    expect(requireAdminSession).toHaveBeenLastCalledWith(expect.anything(), { mutate: true });
  });

  it("serves bounded byte ranges only for the current source and lease", async () => {
    const h = harness(); await h.init(); await h.enqueue();
    const { job } = await h.claim();
    const route = `/internal/custom-game-indexing/${job.id}/source`;
    const headers = { "x-index-lease": job.leaseToken, range: "bytes=1-3" };
    const response = await h.request(route, undefined, { headers });
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 1-3/128");
    expect((await response.arrayBuffer()).byteLength).toBe(3);
    expect((await h.request(route, undefined, { headers: { ...headers, range: "bytes=0-128" } })).status).toBe(416);
    expect((await h.request(route, undefined, { headers: { ...headers, "x-index-lease": "stale" } })).status).toBe(409);
    await h.bucket.put(ZIP, new Uint8Array(128));
    expect((await h.request(route, undefined, { headers })).status).toBe(409);
  });

  it("renews monotonically, accepts the phase transition, and rejects backwards progress", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const route = `/internal/custom-game-indexing/${job.id}/progress`;
    const progress = { leaseToken: job.leaseToken, phase: "downloading", processedBytes: 10, totalBytes: 128, processedFiles: 0, totalFiles: 0 };
    expect((await h.request(route, progress)).status).toBe(200);
    expect((await h.request(route, { ...progress, processedBytes: 9 })).status).toBe(409);
    const indexing = { ...progress, phase: "indexing", processedBytes: 1, totalBytes: 3, totalFiles: 1 };
    expect((await h.request(route, indexing)).status).toBe(200);
    expect((await h.request(route, progress)).status).toBe(409);
  });

  it("publishes a validated version-pinned sidecar and retries completion idempotently", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const payload = { leaseToken: job.leaseToken, manifest: resultManifest(h.game) };
    const route = `/internal/custom-game-indexing/${job.id}/complete`;
    expect((await h.request(route, payload)).status).toBe(200);
    const retry = await (await h.request(route, payload)).json() as any;
    expect(retry.alreadyCompleted).toBe(true);
    expect((await h.request(route, { ...payload, leaseToken: "wrong" })).status).toBe(409);
    const integrity = await (await h.request(`/api/custom-games/${GAME}/integrity`)).json() as any;
    expect(integrity.files[0].zip.offset).toBe(38); expect(integrity.sourceEtag).toBe(job.sourceEtag);
    expect(integrity.indexedAt).toBeTruthy();
    expect((await h.enqueue()).queued).toBe(false);
    expect((await h.enqueue(true)).queued).toBe(true);
  });

  it("cancels a running lease, rejects late completion, and allows explicit retry", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    expect((await h.request(`/panel-api/custom-games/indexing/${job.id}/cancel`, {})).status).toBe(200);
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/complete`, { leaseToken: job.leaseToken, manifest: resultManifest(h.game) })).status).toBe(409);
    expect((await h.request(`/panel-api/custom-games/indexing/${job.id}/retry`, {})).status).toBe(200);
    const next = (await h.claim()).job;
    expect(next.leaseToken).not.toBe(job.leaseToken);
  });

  it("reclaims expired jobs with a new token and stops after three lost leases", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    await h.bucket.patchJob(job.id, { leaseExpiresAt: new Date(0).toISOString() });
    const next = (await h.claim()).job;
    expect(next.leaseToken).not.toBe(job.leaseToken);
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/fail`, { leaseToken: job.leaseToken, error: "old" })).status).toBe(409);
    await h.bucket.patchJob(job.id, { leaseExpiresAt: new Date(0).toISOString(), attempts: 3 });
    expect((await h.claim()).job).toBeNull();
    const dashboard = await (await h.request("/panel-api/custom-games/indexing")).json() as any;
    expect(dashboard.jobs[0].status).toBe("failed");
  });

  it("indexes a legacy folder and rejects results with missing original files", async () => {
    const h = harness({ packageType: "folder" }); await h.init(); await h.enqueue(); const { job } = await h.claim();
    expect(job.files).toHaveLength(1);
    const source = `/internal/custom-game-indexing/${job.id}/source?file=0`;
    expect((await h.request(source, undefined, { method: "HEAD", headers: { "x-index-lease": job.leaseToken } })).headers.get("content-length")).toBe("3");
    const bad = resultManifest(h.game, [{ path: "other.exe", sizeBytes: 3, sha256: SHA }]);
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/complete`, { leaseToken: job.leaseToken, manifest: bad })).status).toBe(409);
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/complete`, { leaseToken: job.leaseToken, manifest: resultManifest(h.game) })).status).toBe(200);
    expect((await getIntegrityManifest(h.getContext(), h.game, h.deps))?.files[0]?.sha256).toBe(SHA);
  });

  it("finishes an old version retained by the version registry after catalog replacement", async () => {
    const h = harness({ historical: true }); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const old = { ...h.game };
    h.game.archive_key = `${GAME}/archives/00000000-0000-4000-8000-000000000099.zip`;
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/complete`, { leaseToken: job.leaseToken, manifest: resultManifest(old) })).status).toBe(200);
    const response = await h.request(`/api/custom-games/${GAME}/integrity?archiveKey=${encodeURIComponent(ZIP)}`);
    expect(response.status).toBe(200); expect((await response.json() as any).archiveKey).toBe(ZIP);
  });

  it("redacts failure tokens before persisting error messages", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    expect((await h.request(`/internal/custom-game-indexing/${job.id}/fail`, { leaseToken: job.leaseToken, error: `${SECRET} ${job.leaseToken}` })).status).toBe(200);
    const dashboard = await (await h.request("/panel-api/custom-games/indexing")).json() as any;
    expect(dashboard.jobs[0].error).toBe("[redacted] [redacted]");
  });

  it("rejects duplicate Windows paths, prefix conflicts, bad ZIP ranges and fake empty hashes", () => {
    const h = harness();
    const file = { path: "Main.exe", sizeBytes: 3, sha256: SHA, zip: { offset: 38, compressedSize: 3, method: 0, crc32: 1 } };
    expect(() => validateIntegrityManifest(resultManifest(h.game, [file, { ...file, path: "main.exe" }]), h.game, h.deps)).toThrow(/duplicados/);
    expect(() => validateIntegrityManifest(resultManifest(h.game, [file, { ...file, path: "Main.exe/data.bin" }]), h.game, h.deps)).toThrow(/conflito/);
    expect(() => validateIntegrityManifest(resultManifest(h.game, [{ ...file, zip: { ...file.zip, offset: 127 } }]), h.game, h.deps)).toThrow(/ZIP/);
    expect(() => validateIntegrityManifest(resultManifest(h.game, [{ ...file, sizeBytes: 0 }]), h.game, h.deps)).toThrow(/vazio/);
  });

  it("publishes and returns Deflate64 locators while retaining range and method validation", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const file = { path: "main.exe", sizeBytes: 3, sha256: SHA,
      zip: { offset: 38, compressedSize: 5, method: 9, crc32: 123 } };
    const manifest = resultManifest(h.game, [file]);
    expect(validateIntegrityManifest(manifest, h.game, h.deps).files[0]?.zip).toEqual(file.zip);
    expect(() => validateIntegrityManifest(resultManifest(h.game, [{ ...file, zip: { ...file.zip, method: 12 } }]), h.game, h.deps)).toThrow(/ZIP/);
    expect(() => validateIntegrityManifest(resultManifest(h.game, [{ ...file, zip: { ...file.zip, offset: 127 } }]), h.game, h.deps)).toThrow(/ZIP/);
    const completed = await h.request(`/internal/custom-game-indexing/${job.id}/complete`, { leaseToken: job.leaseToken, manifest });
    expect(completed.status).toBe(200);
    const response = await h.request(`/api/custom-games/${GAME}/integrity`);
    expect(response.status).toBe(200);
    expect((await response.json() as any).files[0].zip).toEqual(file.zip);
  });

  it("runs the real streaming runner against the real Hono lease/source/complete routes", async () => {
    const name = Buffer.from("main.exe"); const content = Buffer.from("abc"); const checksum = 0x352441c2;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(3, 18); local.writeUInt32LE(3, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(3, 20); central.writeUInt32LE(3, 24); central.writeUInt16LE(name.length, 28);
    const offset = local.length + name.length + content.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offset, 16);
    const zip = Buffer.concat([local, name, content, central, name, end]);
    const h = harness(); await h.init(); h.game.archive_size = zip.length; await h.bucket.put(ZIP, zip); await h.enqueue();
    const directory = await mkdtemp(path.join(tmpdir(), "merlin-runner-api-test-"));
    try {
      const modulePath = "../../scripts/lib/custom-game-indexer.mjs";
      const { IndexerClient, runIndexer } = await import(modulePath);
      const client = new IndexerClient({ apiUrl: "http://localhost", secret: SECRET,
        fetchImpl: (url: string, options: RequestInit) => h.app.request(url, options, h.env) });
      await runIndexer({ client, once: true, tempRoot: directory, rangeBytes: 25, limits: { reserveDiskBytes: 0 }, log: () => {} });
      const manifest = await getIntegrityManifest(h.getContext(), h.game, h.deps);
      expect(manifest?.files[0]?.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      expect(manifest?.files[0]?.zip).toEqual({ offset: 38, compressedSize: 3, method: 0, crc32: checksum });
      expect(manifest?.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readdir(directory)).toEqual([]);
      expect((await h.claim()).job).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("an overlapping completion's failure report cannot abort the winning publication", async () => {
    const h = harness(); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const originalPut = h.bucket.put.bind(h.bucket);
    let release!: () => void; let paused!: () => void; let bothPublishing!: () => void;
    const pausedPromise = new Promise<void>(resolve => { paused = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const both = new Promise<void>(resolve => { bothPublishing = resolve; });
    const sidecar = await integrityManifestKey(GAME, ZIP); let publications = 0;
    h.bucket.put = async (key, value, options) => {
      if (key.startsWith("_integrity-jobs/") && JSON.parse(String(value)).phase === "publishing") {
        if (++publications === 2) bothPublishing();
        await both;
      }
      if (key === sidecar) { paused(); await releasePromise; }
      return originalPut(key, value, options);
    };
    const route = `/internal/custom-game-indexing/${job.id}/complete`;
    const payload = { leaseToken: job.leaseToken, manifest: resultManifest(h.game) };
    const requests = [h.request(route, payload), h.request(route, payload)];
    await pausedPromise;
    expect((await Promise.race(requests)).status).toBe(409);
    const failed = await h.request(`/internal/custom-game-indexing/${job.id}/fail`, { leaseToken: job.leaseToken, error: "retry received 409" });
    expect(failed.status).toBe(409);
    release();
    expect((await Promise.all(requests)).map(response => response.status).sort()).toEqual([200, 409]);
    const dashboard = await (await h.request("/panel-api/custom-games/indexing")).json() as any;
    expect(dashboard.jobs[0].status).toBe("completed");
    expect(await h.bucket.head(sidecar)).toBeTruthy();
  });

  it("honors If-Match when a legacy folder file changes between ranges", async () => {
    const h = harness({ packageType: "folder" }); await h.init(); await h.enqueue(); const { job } = await h.claim();
    const route = `/internal/custom-game-indexing/${job.id}/source?file=0`;
    const first = await h.request(route, undefined, { headers: { "x-index-lease": job.leaseToken, range: "bytes=0-0" } });
    expect(first.status).toBe(206);
    const pinnedEtag = first.headers.get("etag")!;
    await h.bucket.put(h.folder.files[0]!.key, new Uint8Array([4, 5, 6]));
    const next = await h.request(route, undefined, { headers: { "x-index-lease": job.leaseToken,
      "if-match": pinnedEtag, range: "bytes=1-2" } });
    expect(next.status).toBe(409);
  });
});
