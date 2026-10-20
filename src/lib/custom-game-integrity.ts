import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { requireGoldLauncherLicense } from "./launcher-auth";

const JOB_PREFIX = "_integrity-jobs/";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 30 * 1024 ** 3;
const MAX_GAME_BYTES = 200 * 1024 ** 3;
const MAX_ARCHIVE_BYTES = 100 * 1024 ** 3;
const MAX_RANGE_BYTES = 64 * 1024 ** 2;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ID_PATTERN = /^[a-f0-9]{64}$/;
const GAME_PATTERN = /^[a-f0-9-]{36}$/i;
const encoder = new TextEncoder();

export type IntegrityZipLocator = { offset: number; compressedSize: number; method: 0 | 8 | 9; crc32: number };
export type IntegrityFile = { path: string; sizeBytes: number; sha256: string; zip?: IntegrityZipLocator };
export type IntegrityManifest = { version: 1; gameId: string; archiveKey: string; totalSizeBytes: number;
  files: IntegrityFile[]; archiveSha256?: string; sourceEtag?: string; sourceSize?: number; indexedAt?: string };
export type IntegrityGame = { id: string; name?: string; archive_key: string; archive_size: number;
  package_type?: "zip" | "folder"; published?: number };
type FolderFile = { path: string; key: string; sizeBytes: number; sha256?: string; etag?: string };
type FolderManifest = { version: number; totalSizeBytes: number; files: FolderFile[];
  bundles?: { files: { path: string; sizeBytes: number; sha256: string }[] }[] };
export type IntegrityDependencies = {
  findGame: (c: AppContext, id: string) => Promise<IntegrityGame | null>;
  loadFolderManifest: (c: AppContext, key: string) => Promise<FolderManifest>;
  validateGameFilePath: (value: unknown) => string;
  validateSha256: (value: unknown) => string;
  resolveIntegrityPackage?(c: AppContext, game: IntegrityGame, archiveKey: string): Promise<IntegrityGame | null>;
  isPackageAvailable?: (c: AppContext, gameId: string, archiveKey: string) => Promise<boolean>;
};

type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type IntegrityJob = { id: string; gameId: string; gameName: string; archiveKey: string; packageType: "zip" | "folder";
  status: JobStatus; phase: "queued" | "downloading" | "indexing" | "publishing" | "completed" | "failed" | "cancelled";
  processedBytes: number; totalBytes: number; processedFiles: number; totalFiles: number; attempts: number;
  sourceEtag: string; sourceSize: number; createdAt: string; updatedAt: string; indexedAt?: string; fileCount?: number;
  error?: string; leaseToken?: string; leaseExpiresAt?: string; completedLeaseHash?: string;
  queueGeneration?: string; queueCursor?: number; queuePlanKey?: string };

function fail(message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 503 = 400): never {
  throw new HTTPException(status, { message });
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail("Contador ou tamanho inválido.");
  return value;
}
function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""); }
async function digest(value: string) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
export async function integrityJobId(gameId: string, archiveKey: string): Promise<string> { return digest(gameId + archiveKey); }
export async function integrityManifestKey(gameId: string, archiveKey: string): Promise<string> {
  if (!GAME_PATTERN.test(gameId)) fail("Identificador do jogo inválido.");
  return `${gameId}/integrity/${await integrityJobId(gameId, archiveKey)}.json`;
}
function indexNamespace(env: Pick<AppBindings, "ENVIRONMENT">) { return env.ENVIRONMENT === "staging" ? "staging" : "production"; }
function jobPrefix(env: Pick<AppBindings, "ENVIRONMENT">) { return `${JOB_PREFIX}${indexNamespace(env)}/`; }
function lastSeenKey(env: Pick<AppBindings, "ENVIRONMENT">) { return `_integrity-worker/${indexNamespace(env)}/last-seen.json`; }
export function indexJobKey(env: Pick<AppBindings, "ENVIRONMENT">, id: string) {
  if (!ID_PATTERN.test(id)) fail("Identificador da indexação inválido.");
  return `${jobPrefix(env)}${id}.json`;
}
export async function integrityJobKey(env: Pick<AppBindings, "ENVIRONMENT">, gameId: string, archiveKey: string) {
  return indexJobKey(env, await integrityJobId(gameId, archiveKey));
}
function safeMessage(value: unknown, tokens: (string | undefined)[] = []): string {
  let message = String(value || "Falha durante a indexação.");
  for (const token of tokens) if (token) message = message.split(token).join("[redacted]");
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
}
function publicJob(job: IntegrityJob) {
  return { id: job.id, gameId: job.gameId, gameName: job.gameName, packageType: job.packageType,
    status: job.status, phase: job.phase, processedBytes: job.processedBytes, totalBytes: job.totalBytes,
    processedFiles: job.processedFiles, totalFiles: job.totalFiles, attempts: job.attempts,
    createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    ...(job.indexedAt ? { indexedAt: job.indexedAt } : {}), ...(job.fileCount !== undefined ? { fileCount: job.fileCount } : {}),
    ...(job.error ? { error: job.error.slice(0, 120) } : {}) };
}
function jobMetadata(job: IntegrityJob): Record<string, string> {
  const visible = publicJob(job);
  // R2 custom metadata is limited to 2 KiB including keys. Bound names and
  // errors independently so the job list never needs to GET every job body.
  return { job: JSON.stringify({ ...visible, gameName: visible.gameName.slice(0, 160) }) };
}
export async function readJob(env: AppBindings, id: string) {
  const object = await env.CUSTOM_GAMES.get(indexJobKey(env, id));
  if (!object) return null;
  if (object.size > 16 * 1024) fail("Registro de indexação inválido.", 409);
  const job = await object.json<IntegrityJob>();
  if (job.id !== id || !GAME_PATTERN.test(job.gameId) || !["zip", "folder"].includes(job.packageType)) fail("Registro de indexação inválido.", 409);
  return { job, etag: object.etag };
}
export async function writeJob(env: AppBindings, job: IntegrityJob, etag?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await env.CUSTOM_GAMES.put(indexJobKey(env, job.id), JSON.stringify(job), { httpMetadata: { contentType: "application/json" },
        customMetadata: jobMetadata(job), onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = (error as { status?: number; statusCode?: number })?.status || (error as { statusCode?: number })?.statusCode;
      if (attempt >= 3 || !(status === 429 || status === 503 || /\b429\b|\b503\b|too many|rate.?limit|SlowDown/i.test(message))) throw error;
      // R2 limits concurrent writes to one key. Retrying preserves the CAS so
      // cancellation or a newer generation still wins during this backoff.
      await new Promise(resolve => setTimeout(resolve, 1100 * 2 ** attempt));
    }
  }
}
export async function listJobs(env: AppBindings) {
  const jobs: ReturnType<typeof publicJob>[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CUSTOM_GAMES.list({ prefix: jobPrefix(env), include: ["customMetadata"], limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      try {
        const value = JSON.parse(object.customMetadata?.job || "null") as ReturnType<typeof publicJob> | null;
        if (value && ID_PATTERN.test(value.id) && GAME_PATTERN.test(value.gameId) && ["queued", "processing", "completed", "failed", "cancelled"].includes(value.status)) jobs.push(value);
      } catch { /* A corrupt unrelated object must not hide the rest of the queue. */ }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return jobs;
}
async function limitedJson(c: AppContext, limit = MAX_MANIFEST_BYTES): Promise<Record<string, unknown>> {
  const declared = c.req.header("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail("Corpo da solicitação acima do limite.", 413);
  const body = c.req.raw.body;
  if (!body) fail("Corpo JSON obrigatório.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) { await reader.cancel(); fail("Corpo da solicitação acima do limite.", 413); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("JSON inválido."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Objeto JSON obrigatório.");
  return parsed as Record<string, unknown>;
}
async function requireIndexer(c: AppContext) {
  const secret = c.env.CUSTOM_GAME_INDEXER_SECRET;
  if (!secret) fail("Indexador externo ainda não foi configurado.", 503);
  const header = c.req.header("authorization") || "";
  if (header.length > 4096 || !header.startsWith("Bearer ")) fail("Acesso não autorizado.", 401);
  const [left, right] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))), crypto.subtle.digest("SHA-256", encoder.encode(secret))]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= a[index]! ^ b[index]!;
  if (difference) fail("Acesso não autorizado.", 401);
}
export async function workerSeen(env: AppBindings) {
  const now = new Date().toISOString();
  const prior = await env.CUSTOM_GAMES.head(lastSeenKey(env));
  // Avoid creating an object write on every 16 MiB range request.
  if (prior && Date.now() - prior.uploaded.getTime() < 30_000) return;
  await env.CUSTOM_GAMES.put(lastSeenKey(env), JSON.stringify({ at: now }), { customMetadata: { at: now },
    ...(prior ? { onlyIf: { etagMatches: prior.etag } } : { onlyIf: { etagDoesNotMatch: "*" } }) });
}
export async function available(c: AppContext, job: Pick<IntegrityJob, "gameId" | "archiveKey">, deps: IntegrityDependencies) {
  if (deps.isPackageAvailable) return deps.isPackageAvailable(c, job.gameId, job.archiveKey);
  const game = await deps.findGame(c, job.gameId);
  return game?.archive_key === job.archiveKey;
}
async function leaseJob(c: AppContext, id: string, token: unknown, deps: IntegrityDependencies) {
  const record = await readJob(c.env, id);
  if (!record) fail("Indexação não encontrada.", 404);
  if (record.job.status !== "processing" || typeof token !== "string" || token !== record.job.leaseToken ||
    !record.job.leaseExpiresAt || Date.parse(record.job.leaseExpiresAt) <= Date.now()) fail("Lease da indexação expirou ou foi substituído.", 409);
  if (!await available(c, record.job, deps)) fail("O pacote desta indexação não está mais disponível.", 409);
  return record;
}
export async function sourceVersion(c: AppContext, job: IntegrityJob) {
  const source = await c.env.CUSTOM_GAMES.head(job.archiveKey);
  if (!source || source.etag !== job.sourceEtag || (job.packageType === "zip" && source.size !== job.sourceSize)) {
    fail("O pacote mudou desde o início da indexação.", 409);
  }
  return source;
}

export function validateIntegrityManifest(value: unknown, game: IntegrityGame, deps: Pick<IntegrityDependencies, "validateGameFilePath" | "validateSha256">): IntegrityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Manifesto de integridade inválido.");
  const input = value as IntegrityManifest;
  if (input.version !== 1 || input.gameId !== game.id || input.archiveKey !== game.archive_key || !Array.isArray(input.files) ||
    !input.files.length || input.files.length > MAX_FILES) fail("Manifesto de integridade não corresponde ao jogo.");
  const paths = new Set<string>();
  const canonical = new Map<string, string>();
  let totalSizeBytes = 0;
  const zip = (game.package_type || "zip") === "zip";
  const files = input.files.map(file => {
    if (!file || typeof file !== "object") fail("Arquivo de integridade inválido.");
    const path = deps.validateGameFilePath(file.path);
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(key)) fail("Manifesto de integridade contém caminhos duplicados.");
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      const normalized = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      if (canonical.has(normalized) && canonical.get(normalized) !== prefix) fail("Manifesto contém caminhos com caixa ou Unicode ambíguos.");
      canonical.set(normalized, prefix);
    }
    paths.add(key);
    const sizeBytes = count(file.sizeBytes, MAX_FILE_BYTES);
    totalSizeBytes = count(totalSizeBytes + sizeBytes, MAX_GAME_BYTES);
    const sha256 = deps.validateSha256(file.sha256);
    if (!sizeBytes && sha256 !== EMPTY_SHA) fail("Hash de arquivo vazio inválido.");
    let locator: IntegrityZipLocator | undefined;
    if (zip) {
      if (!file.zip || typeof file.zip !== "object" || ![0, 8, 9].includes(file.zip.method)) fail("Posição do arquivo no ZIP inválida.");
      const offset = count(file.zip.offset, MAX_ARCHIVE_BYTES);
      const compressedSize = count(file.zip.compressedSize, MAX_ARCHIVE_BYTES);
      const crc32 = count(file.zip.crc32, 0xffffffff);
      if (offset < 30 || offset + compressedSize > game.archive_size ||
        (file.zip.method === 0 && compressedSize !== sizeBytes) || (sizeBytes && !compressedSize)) fail("Posição do arquivo ultrapassa o ZIP.");
      locator = { offset, compressedSize, method: file.zip.method, crc32 };
    } else if (file.zip !== undefined) fail("Manifesto de pasta não deve conter posições ZIP.");
    return { path, sizeBytes, sha256, ...(locator ? { zip: locator } : {}) };
  });
  for (const key of paths) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length++) if (paths.has(parts.slice(0, length).join("/"))) fail("Manifesto contém conflito entre arquivo e pasta.");
  }
  if (input.totalSizeBytes !== totalSizeBytes || totalSizeBytes < 1) fail("Tamanho do manifesto de integridade inválido.");
  if (!zip && game.archive_size !== totalSizeBytes) fail("Manifesto de integridade não corresponde ao tamanho da pasta.");
  if (zip) {
    const ranges = files.map(file => file.zip!).sort((a, b) => a.offset - b.offset);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]!.offset < ranges[index - 1]!.offset + ranges[index - 1]!.compressedSize) fail("Manifesto ZIP contém intervalos sobrepostos.");
  }
  return { version: 1, gameId: game.id, archiveKey: game.archive_key, totalSizeBytes, files,
    ...(input.archiveSha256 ? { archiveSha256: deps.validateSha256(input.archiveSha256) } : {}),
    ...(typeof input.sourceEtag === "string" ? { sourceEtag: input.sourceEtag.slice(0, 200) } : {}),
    ...(typeof input.sourceSize === "number" ? { sourceSize: count(input.sourceSize, MAX_GAME_BYTES) } : {}),
    ...(typeof input.indexedAt === "string" && Number.isFinite(Date.parse(input.indexedAt)) ? { indexedAt: input.indexedAt } : {}) };
}

export async function storeManifest(c: AppContext, manifest: IntegrityManifest) {
  const serialized = JSON.stringify(manifest);
  if (encoder.encode(serialized).byteLength > MAX_MANIFEST_BYTES) fail("Manifesto de integridade acima do limite.", 413);
  await c.env.CUSTOM_GAMES.put(await integrityManifestKey(manifest.gameId, manifest.archiveKey), serialized,
    { httpMetadata: { contentType: "application/json" }, customMetadata: { gameId: manifest.gameId,
      indexedAt: manifest.indexedAt || new Date().toISOString(), fileCount: String(manifest.files.length),
      ...(manifest.sourceEtag ? { sourceEtag: manifest.sourceEtag } : {}) } });
}

export async function getIntegrityManifest(c: AppContext, game: IntegrityGame, deps: IntegrityDependencies): Promise<IntegrityManifest | null> {
  if (!game.archive_key || game.archive_key.startsWith("draft/")) return null;
  const sidecar = await c.env.CUSTOM_GAMES.get(await integrityManifestKey(game.id, game.archive_key));
  if (sidecar) {
    if (sidecar.size > MAX_MANIFEST_BYTES) fail("Manifesto de integridade inválido.", 409);
    return validateIntegrityManifest(await sidecar.json(), game, deps);
  }
  if ((game.package_type || "zip") !== "folder") return null;
  const folder = await deps.loadFolderManifest(c, game.archive_key);
  const files = [...folder.files, ...(folder.bundles || []).flatMap(bundle => bundle.files)];
  if (!files.length || files.some(file => !file.sha256)) return null;
  const manifest = validateIntegrityManifest({ version: 1, gameId: game.id, archiveKey: game.archive_key,
    totalSizeBytes: folder.totalSizeBytes, files: files.map(file => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 })),
    indexedAt: new Date().toISOString() }, game, deps);
  await storeManifest(c, manifest);
  return manifest;
}

export async function enqueueGameIntegrity(c: AppContext, game: IntegrityGame, deps: IntegrityDependencies, { force = false } = {}) {
  if (!game.archive_key || game.archive_key.startsWith("draft/")) return { queued: false, skipped: true, reason: "no_package" };
  const packageType = game.package_type || "zip";
  const existingManifest = await getIntegrityManifest(c, game, deps);
  if (existingManifest && (!force || packageType === "folder")) return { queued: false, skipped: true, reason: "ready" };
  const source = await c.env.CUSTOM_GAMES.head(game.archive_key);
  if (!source || (packageType === "zip" && (!source.size || source.size > MAX_ARCHIVE_BYTES || source.size !== game.archive_size))) {
    fail("Pacote do jogo não encontrado ou não corresponde ao cadastro.", 409);
  }
  let totalFiles = 0;
  if (packageType === "folder") {
    const folder = await deps.loadFolderManifest(c, game.archive_key);
    if (folder.bundles?.length) fail("Pacote de pasta incompleto: reenvie o manifesto com os hashes.", 409);
    totalFiles = folder.files.length;
  }
  const id = await integrityJobId(game.id, game.archive_key);
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await readJob(c.env, id);
    if (previous && ["queued", "processing"].includes(previous.job.status)) {
      if (previous.job.status === "queued") await dispatchIntegrityQueueJob(c.env, previous);
      return { queued: false, skipped: true, reason: previous.job.status, jobId: id };
    }
    const now = new Date().toISOString();
    const job: IntegrityJob = { id, gameId: game.id, gameName: String(game.name || game.id).slice(0, 160), archiveKey: game.archive_key,
      packageType, sourceEtag: source.etag, sourceSize: packageType === "zip" ? source.size : game.archive_size,
      status: "queued", phase: "queued", processedBytes: 0, totalBytes: packageType === "zip" ? source.size : game.archive_size,
      processedFiles: 0, totalFiles, attempts: 0, createdAt: now, updatedAt: now,
      ...(c.env.CUSTOM_GAME_INDEX_QUEUE ? { queueGeneration: crypto.randomUUID(), queueCursor: 0 } : {}) };
    if (await writeJob(c.env, job, previous?.etag)) {
      await dispatchIntegrityQueueJob(c.env, { job });
      return { queued: true, skipped: false, jobId: id };
    }
  }
  fail("A fila mudou durante a solicitação. Tente novamente.", 409);
}

/** R2 is the durable journal; Queues is execution. Cron repairs a lost send. */
export async function dispatchIntegrityQueueJob(env: AppBindings, record: { job: IntegrityJob; etag?: string }) {
  if (!env.CUSTOM_GAME_INDEX_QUEUE) return;
  let job = record.job;
  if (!job.queueGeneration) {
    job = { ...job, queueGeneration: crypto.randomUUID(), queueCursor: 0 };
    if (!await writeJob(env, job, record.etag)) return;
  }
  try { await env.CUSTOM_GAME_INDEX_QUEUE.send({ jobId: job.id, generation: job.queueGeneration! }); }
  catch { console.warn("[CustomGamesIntegrity] queue-send-deferred", { jobId: job.id }); }
}

export async function dispatchPendingIntegrityQueue(env: AppBindings) {
  if (!env.CUSTOM_GAME_INDEX_QUEUE) return;
  for (const listed of await listJobs(env)) {
    if (listed.status !== "queued" && !(listed.status === "processing" && Date.parse(listed.leaseExpiresAt || "") <= Date.now())) continue;
    const record = await readJob(env, listed.id);
    if (!record || (record.job.status !== "queued" && !(record.job.status === "processing" && Date.parse(record.job.leaseExpiresAt || "") <= Date.now()))) continue;
    if (record.job.status === "processing" && record.job.queueGeneration && record.job.attempts >= 4) {
      const failed: IntegrityJob = { ...record.job, status: "failed", phase: "failed", updatedAt: new Date().toISOString(),
        error: "A execução na Cloudflare esgotou as tentativas. Confira o pacote e tente novamente." };
      delete failed.leaseToken; delete failed.leaseExpiresAt;
      await writeJob(env, failed, record.etag);
      continue;
    }
    await dispatchIntegrityQueueJob(env, record);
  }
}

async function failExpiredJob(c: AppContext, record: { job: IntegrityJob; etag: string }) {
  const now = new Date().toISOString();
  const job = { ...record.job, status: "failed" as const, phase: "failed" as const, updatedAt: now,
    error: "O indexador perdeu o lease três vezes. Confira o serviço e tente novamente." };
  delete job.leaseToken; delete job.leaseExpiresAt;
  await writeJob(c.env, job, record.etag);
}

export function registerCustomGameIntegrityRoutes(app: Hono<{ Bindings: AppBindings }>, deps: IntegrityDependencies) {
  async function indexingStatus(c: AppContext) {
    const [listed, rows, worker] = await Promise.all([listJobs(c.env),
      c.env.merlin_db.prepare("SELECT id,name,archive_key,archive_size,package_type,published FROM custom_games WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE").all<IntegrityGame>(),
      c.env.CUSTOM_GAMES.head(lastSeenKey(c.env))]);
    const lookup = new Map(listed.map(job => [job.id, job]));
    const games = [];
    // Inspect small sidecar metadata; existing folder hashes are indexed once
    // without re-reading their data objects.
    for (const game of rows.results) {
      const id = await integrityJobId(game.id, game.archive_key);
      const job = lookup.get(id);
      let meta = await c.env.CUSTOM_GAMES.head(await integrityManifestKey(game.id, game.archive_key));
      if (!meta && (game.package_type || "zip") === "folder" && !game.archive_key.startsWith("draft/")) {
        const manifest = await getIntegrityManifest(c, game, deps);
        if (manifest) meta = await c.env.CUSTOM_GAMES.head(await integrityManifestKey(game.id, game.archive_key));
      }
      const indexStatus = job && ["queued", "processing"].includes(job.status) ? job.status : meta ? "ready" : job?.status === "failed" ? "failed" : "missing";
      games.push({ id: game.id, name: game.name || game.id, packageType: game.package_type || "zip", indexStatus,
        ...(meta?.customMetadata?.indexedAt ? { indexedAt: meta.customMetadata.indexedAt } : {}),
        ...(meta?.customMetadata?.fileCount ? { fileCount: Number(meta.customMetadata.fileCount) } : {}) });
    }
    const summary = { queued: 0, processing: 0, completed: 0, failed: 0, missing: 0 };
    for (const game of games) {
      const status = game.indexStatus;
      if (status === "ready") summary.completed++;
      else if (status === "queued" || status === "processing" || status === "failed" || status === "missing") summary[status]++;
    }
    return c.json({ success: true, summary, jobs: listed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), games,
      workerConfigured: Boolean(c.env.CUSTOM_GAME_INDEX_QUEUE || c.env.CUSTOM_GAME_INDEXER_SECRET),
      executionMode: c.env.CUSTOM_GAME_INDEX_QUEUE ? "cloudflare-queues" : "external",
      workerLastSeenAt: worker?.customMetadata?.at || null }, 200, { "cache-control": "private, no-store" });
  }

  async function enqueueIndexing(c: AppContext) {
    const body = await limitedJson(c, 4096);
    if (body.mode !== "missing" && body.mode !== "all") fail("Modo de indexação inválido.");
    let games: IntegrityGame[];
    if (body.gameId !== undefined) {
      if (typeof body.gameId !== "string" || !GAME_PATTERN.test(body.gameId)) fail("Identificador do jogo inválido.");
      const game = await deps.findGame(c, body.gameId);
      if (!game) fail("Jogo não encontrado.", 404);
      games = [game];
    } else games = (await c.env.merlin_db.prepare("SELECT id,name,archive_key,archive_size,package_type,published FROM custom_games WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE").all<IntegrityGame>()).results;
    let queued = 0; let skipped = 0;
    const errors: { gameId: string; error: string }[] = [];
    for (const game of games) {
      try { const result = await enqueueGameIntegrity(c, game, deps, { force: body.mode === "all" }); result.queued ? queued++ : skipped++; }
      catch (error) { skipped++; errors.push({ gameId: game.id, error: safeMessage(error instanceof Error ? error.message : error) }); }
    }
    return c.json({ success: true, queued, skipped, ...(errors.length ? { errors } : {}) }, 200, { "cache-control": "private, no-store" });
  }

  app.get("/panel-api/custom-games/indexing", async c => {
    await requireAdminSession(c);
    return indexingStatus(c);
  });

  app.post("/panel-api/custom-games/indexing", async c => {
    await requireAdminSession(c, { mutate: true });
    return enqueueIndexing(c);
  });

  app.get("/internal/custom-game-indexing/status", async c => {
    await requireIndexer(c);
    return indexingStatus(c);
  });

  app.post("/internal/custom-game-indexing/enqueue", async c => {
    await requireIndexer(c);
    return enqueueIndexing(c);
  });

  app.post("/panel-api/custom-games/indexing/:id/retry", async c => {
    await requireAdminSession(c, { mutate: true });
    const record = await readJob(c.env, c.req.param("id"));
    if (!record) fail("Indexação não encontrada.", 404);
    if (["queued", "processing"].includes(record.job.status)) fail("Esta indexação já está na fila.", 409);
    if (!await available(c, record.job, deps)) fail("O pacote desta versão não está mais disponível.", 409);
    await sourceVersion(c, record.job);
    const job: IntegrityJob = { ...record.job, status: "queued", phase: "queued", attempts: 0, processedBytes: 0, processedFiles: 0, updatedAt: new Date().toISOString(),
      ...(c.env.CUSTOM_GAME_INDEX_QUEUE ? { queueGeneration: crypto.randomUUID(), queueCursor: 0 } : {}) };
    delete job.queuePlanKey;
    delete job.error; delete job.leaseToken; delete job.leaseExpiresAt; delete job.completedLeaseHash;
    if (!await writeJob(c.env, job, record.etag)) fail("A indexação mudou durante a solicitação.", 409);
    await dispatchIntegrityQueueJob(c.env, { job });
    return c.json({ success: true, job: publicJob(job) });
  });

  app.post("/panel-api/custom-games/indexing/:id/cancel", async c => {
    await requireAdminSession(c, { mutate: true });
    const record = await readJob(c.env, c.req.param("id"));
    if (!record) fail("Indexação não encontrada.", 404);
    if (record.job.status === "cancelled") return c.json({ success: true, job: publicJob(record.job) });
    if (!["queued", "processing"].includes(record.job.status) || record.job.phase === "publishing") fail("A indexação já foi finalizada ou está publicando o resultado.", 409);
    const job: IntegrityJob = { ...record.job, status: "cancelled", phase: "cancelled", updatedAt: new Date().toISOString(), error: "Indexação cancelada pelo administrador." };
    delete job.leaseToken; delete job.leaseExpiresAt;
    if (!await writeJob(c.env, job, record.etag)) fail("A indexação mudou durante a solicitação.", 409);
    return c.json({ success: true, job: publicJob(job) });
  });

  app.get("/api/custom-games/:id/integrity", async c => {
    await requireGoldLauncherLicense(c);
    let game = await deps.findGame(c, c.req.param("id"));
    if (!game || !game.published) fail("Jogo não encontrado.", 404);
    const requested = c.req.query("archiveKey");
    if (requested && requested !== game.archive_key) {
      const resolved = await deps.resolveIntegrityPackage?.(c, game, requested);
      if (!resolved) fail("A versão solicitada não possui manifesto disponível.", 409);
      game = resolved;
    }
    const manifest = await getIntegrityManifest(c, game, deps);
    if (!manifest) fail("A integridade desta versão ainda não foi indexada.", 409);
    return c.json({ success: true, ...manifest }, 200, { "cache-control": "private, no-store" });
  });

  app.post("/internal/custom-game-indexing/claim", async c => {
    await requireIndexer(c);
    await limitedJson(c, 4096);
    if (c.env.CUSTOM_GAME_INDEX_QUEUE) return c.json({ job: null, executionMode: "cloudflare-queues" }, 200, { "cache-control": "no-store" });
    await workerSeen(c.env);
    const jobs = (await listJobs(c.env)).filter(job => job.status === "queued" ||
      (job.status === "processing" && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now())))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const candidate of jobs) {
      const record = await readJob(c.env, candidate.id);
      if (!record || (record.job.status !== "queued" && !(record.job.status === "processing" && Date.parse(record.job.leaseExpiresAt || "") <= Date.now()))) continue;
      if (record.job.attempts >= MAX_ATTEMPTS) { await failExpiredJob(c, record); continue; }
      if (!await available(c, record.job, deps)) {
        const failed: IntegrityJob = { ...record.job, status: "failed", phase: "failed", updatedAt: new Date().toISOString(), error: "O pacote desta versão não está mais disponível." };
        delete failed.leaseToken; delete failed.leaseExpiresAt;
        await writeJob(c.env, failed, record.etag); continue;
      }
      let folder: FolderManifest | undefined;
      try { await sourceVersion(c, record.job); if (record.job.packageType === "folder") folder = await deps.loadFolderManifest(c, record.job.archiveKey); }
      catch (error) {
        const failed: IntegrityJob = { ...record.job, status: "failed", phase: "failed", updatedAt: new Date().toISOString(), error: safeMessage(error instanceof Error ? error.message : error) };
        delete failed.leaseToken; delete failed.leaseExpiresAt;
        await writeJob(c.env, failed, record.etag); continue;
      }
      const now = new Date();
      const claimed: IntegrityJob = { ...record.job, status: "processing", phase: record.job.packageType === "zip" ? "downloading" : "indexing",
        processedBytes: 0, processedFiles: 0, totalBytes: record.job.sourceSize, attempts: record.job.attempts + 1,
        leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(), updatedAt: now.toISOString() };
      delete claimed.error;
      if (!await writeJob(c.env, claimed, record.etag)) continue;
      return c.json({ job: { id: claimed.id, gameId: claimed.gameId, archiveKey: claimed.archiveKey, packageType: claimed.packageType,
        leaseToken: claimed.leaseToken, sourceEtag: claimed.sourceEtag, sourceSize: claimed.sourceSize, leaseExpiresAt: claimed.leaseExpiresAt,
        ...(folder ? { files: folder.files.map(file => ({ path: file.path, key: file.key, sizeBytes: file.sizeBytes,
          ...(file.sha256 ? { sha256: file.sha256 } : {}), ...(file.etag ? { etag: file.etag } : {}) })) } : {}) } }, 200, { "cache-control": "no-store" });
    }
    return c.json({ job: null }, 200, { "cache-control": "no-store" });
  });

  app.on(["GET", "HEAD"], "/internal/custom-game-indexing/:id/source", async c => {
    await requireIndexer(c);
    const { job } = await leaseJob(c, c.req.param("id"), c.req.header("x-index-lease"), deps);
    const source = await sourceVersion(c, job);
    let key = job.archiveKey; let size = source.size; let etag = source.etag;
    if (job.packageType === "folder") {
      const index = c.req.query("file");
      if (!index || !/^\d+$/.test(index)) fail("Índice do arquivo inválido.");
      const files = (await deps.loadFolderManifest(c, job.archiveKey)).files;
      const file = files[Number(index)];
      if (!file) fail("Arquivo do jogo não encontrado.", 404);
      const object = await c.env.CUSTOM_GAMES.head(file.key);
      if (!object || object.size !== file.sizeBytes || (file.etag && object.etag !== file.etag.replace(/^"|"$/g, ""))) fail("Arquivo da pasta mudou desde o upload.", 409);
      key = file.key; size = object.size; etag = object.etag;
    } else if (c.req.query("file") !== undefined) fail("ZIP não aceita índice de arquivo na origem.");
    const requestedEtag = c.req.header("if-match");
    if (requestedEtag && requestedEtag !== `"${etag}"` && requestedEtag !== etag) {
      fail("A versão do arquivo mudou durante a indexação.", 409);
    }
    const headers = { etag: `"${etag}"`, "accept-ranges": "bytes", "cache-control": "no-store", "content-type": "application/octet-stream" };
    if (c.req.method === "HEAD") return new Response(null, { headers: { ...headers, "content-length": String(size) } });
    const range = /^bytes=(\d+)-(\d+)$/.exec(c.req.header("range") || "");
    if (!range) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    const start = Number(range[1]); const end = Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end >= size || end - start + 1 > MAX_RANGE_BYTES) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    const object = await c.env.CUSTOM_GAMES.get(key, { onlyIf: { etagMatches: etag }, range: { offset: start, length: end - start + 1 } });
    if (!object || !("body" in object) || !object.body) fail("A origem mudou durante a leitura.", 409);
    return new Response(object.body, { status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  });

  app.post("/internal/custom-game-indexing/:id/progress", async c => {
    await requireIndexer(c);
    const body = await limitedJson(c, 4096);
    const record = await leaseJob(c, c.req.param("id"), body.leaseToken, deps);
    const phase = body.phase;
    if (phase !== "downloading" && phase !== "indexing") fail("Fase da indexação inválida.");
    if (record.job.phase === "publishing" || (record.job.phase === "indexing" && phase === "downloading") ||
      (record.job.packageType === "folder" && phase !== "indexing")) fail("A fase da indexação não pode retroceder.", 409);
    const processedBytes = count(body.processedBytes, MAX_GAME_BYTES);
    const totalBytes = count(body.totalBytes, phase === "downloading" ? MAX_ARCHIVE_BYTES : MAX_GAME_BYTES);
    const processedFiles = count(body.processedFiles, MAX_FILES);
    const totalFiles = count(body.totalFiles, MAX_FILES);
    if (processedBytes > totalBytes || processedFiles > totalFiles ||
      (phase === "downloading" && totalBytes !== record.job.sourceSize) ||
      (phase === record.job.phase && (processedBytes < record.job.processedBytes || processedFiles < record.job.processedFiles || totalBytes !== record.job.totalBytes))) {
      fail("Progresso de indexação inválido ou fora de ordem.", 409);
    }
    const now = new Date();
    const updated: IntegrityJob = { ...record.job, phase, processedBytes, totalBytes, processedFiles, totalFiles,
      updatedAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString() };
    if (!await writeJob(c.env, updated, record.etag)) fail("O lease mudou durante a atualização.", 409);
    await workerSeen(c.env);
    return c.json({ success: true, leaseExpiresAt: updated.leaseExpiresAt });
  });

  app.post("/internal/custom-game-indexing/:id/complete", async c => {
    await requireIndexer(c);
    const body = await limitedJson(c);
    const id = c.req.param("id");
    const existing = await readJob(c.env, id);
    if (existing?.job.status === "completed" && typeof body.leaseToken === "string" && existing.job.completedLeaseHash === await digest(body.leaseToken)) {
      return c.json({ success: true, alreadyCompleted: true });
    }
    const record = await leaseJob(c, id, body.leaseToken, deps);
    await sourceVersion(c, record.job);
    const game: IntegrityGame = { id: record.job.gameId, archive_key: record.job.archiveKey, archive_size: record.job.sourceSize, package_type: record.job.packageType };
    const manifest = validateIntegrityManifest(body.manifest, game, deps);
    if (record.job.packageType === "folder") {
      const folder = await deps.loadFolderManifest(c, record.job.archiveKey);
      const lookup = new Map(folder.files.map(file => [file.path, file]));
      if (lookup.size !== manifest.files.length || manifest.files.some(file => {
        const original = lookup.get(file.path);
        return !original || original.sizeBytes !== file.sizeBytes || (original.sha256 && original.sha256 !== file.sha256);
      })) fail("O resultado não corresponde aos arquivos da pasta.", 409);
    }
    const now = new Date().toISOString();
    manifest.sourceEtag = record.job.sourceEtag; manifest.sourceSize = record.job.sourceSize; manifest.indexedAt = now;
    const publishing: IntegrityJob = { ...record.job, phase: "publishing", updatedAt: now, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
    const publication = await writeJob(c.env, publishing, record.etag);
    if (!publication) {
      const current = await readJob(c.env, id);
      if (current?.job.status === "completed" && current.job.completedLeaseHash === await digest(record.job.leaseToken!)) {
        return c.json({ success: true, alreadyCompleted: true });
      }
      fail("O lease mudou antes da publicação.", 409);
    }
    await storeManifest(c, manifest);
    const completed: IntegrityJob = { ...publishing, status: "completed", phase: "completed", updatedAt: now, indexedAt: now,
      processedBytes: manifest.totalSizeBytes, totalBytes: manifest.totalSizeBytes, processedFiles: manifest.files.length, totalFiles: manifest.files.length,
      fileCount: manifest.files.length, completedLeaseHash: await digest(record.job.leaseToken!) };
    delete completed.leaseToken; delete completed.leaseExpiresAt; delete completed.error;
    if (!await writeJob(c.env, completed, publication.etag)) fail("A publicação mudou antes da confirmação.", 409);
    return c.json({ success: true });
  });

  app.post("/internal/custom-game-indexing/:id/fail", async c => {
    await requireIndexer(c);
    const body = await limitedJson(c, 4096);
    const record = await leaseJob(c, c.req.param("id"), body.leaseToken, deps);
    // A lost/retried completion can still be publishing in another request.
    // Its failure report must not invalidate that valid in-flight publication.
    if (record.job.phase === "publishing") fail("A indexação está publicando o resultado. Aguarde a conclusão.", 409);
    const job: IntegrityJob = { ...record.job, status: "failed", phase: "failed", updatedAt: new Date().toISOString(),
      error: safeMessage(body.error, [record.job.leaseToken, c.env.CUSTOM_GAME_INDEXER_SECRET]) };
    delete job.leaseToken; delete job.leaseExpiresAt;
    if (!await writeJob(c.env, job, record.etag)) fail("O lease mudou durante a atualização.", 409);
    return c.json({ success: true });
  });
}
