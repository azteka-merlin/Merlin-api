import type { AppBindings, AppContext } from "../types";
import { available, readJob, sourceVersion, storeManifest, validateIntegrityManifest, workerSeen, writeJob,
  type IntegrityDependencies, type IntegrityFile, type IntegrityJob } from "./custom-game-integrity";
import { planCloudflareZip, hashCloudflareZipEntry, type CloudflareZipEntry } from "./custom-game-cloudflare-zip";

export type IntegrityQueueMessage = { jobId: string; generation: string };
type FolderEntry = { path: string; key: string; sizeBytes: number; etag?: string; sha256?: string };
type Plan = { version: 1; totalSizeBytes: number; files: (CloudflareZipEntry | FolderEntry)[] };
type Part = { from: number; to: number; files: IntegrityFile[] };
const MAX_PLAN_BYTES = 16 * 1024 ** 2;
const LEASE_MS = 20 * 60_000;
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/i;
const encoder = new TextEncoder();

function workPrefix(env: AppBindings, job: IntegrityJob) {
  return `_integrity-work/${env.ENVIRONMENT === "staging" ? "staging" : "production"}/${job.id}/${job.queueGeneration}/`;
}
async function readJson<T>(bucket: R2Bucket, key: string, limit = MAX_PLAN_BYTES): Promise<T> {
  const object = await bucket.get(key);
  if (!object || object.size > limit) throw new Error("Checkpoint de indexação não encontrado ou acima do limite.");
  return object.json<T>();
}
async function hashFolderFile(bucket: R2Bucket, file: FolderEntry, onProgress: (bytes: number) => Promise<void>): Promise<IntegrityFile> {
  const meta = await bucket.head(file.key);
  if (!meta || meta.size !== file.sizeBytes || (file.etag && file.etag !== meta.etag)) throw new Error("Arquivo da pasta mudou durante a indexação.");
  const object = await bucket.get(file.key, { onlyIf: { etagMatches: meta.etag } });
  if (!object || !("body" in object)) throw new Error("Arquivo da pasta mudou durante a leitura.");
  const digest = new crypto.DigestStream("SHA-256");
  // Observe digest rejection immediately so a truncated stream has no unhandled rejection.
  const hash = digest.digest.then(bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join(""));
  void hash.catch(() => {});
  let bytes = 0; let lastReported = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({ async transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > file.sizeBytes) throw new Error("Arquivo da pasta ultrapassa o tamanho declarado.");
    controller.enqueue(chunk);
    if (bytes - lastReported >= 8 * 1024 ** 2) { lastReported = bytes; await onProgress(bytes); }
  } });
  await object.body.pipeThrough(counter).pipeTo(digest);
  const sha256 = await hash;
  if (bytes !== file.sizeBytes || (file.sha256 && file.sha256 !== sha256)) throw new Error("Conteúdo da pasta não corresponde ao manifesto.");
  return { path: file.path, sizeBytes: bytes, sha256 };
}

type ProcessorOptions = {
  planZip?: typeof planCloudflareZip; hashZip?: typeof hashCloudflareZipEntry;
  hashFolder?: typeof hashFolderFile; maxFiles?: number; maxMilliseconds?: number;
  onClaim?: (token: string) => void;
};

/** One message advances a bounded set of files; the next invocation resumes from R2. */
export async function processCloudflareIntegrityMessage(env: AppBindings, body: IntegrityQueueMessage,
  deps: IntegrityDependencies, attempt = 1, options: ProcessorOptions = {}) {
  if (!body || !ID.test(body.jobId) || !UUID.test(body.generation)) return;
  let record = await readJob(env, body.jobId);
  if (!record || record.job.queueGeneration !== body.generation || !["queued", "processing"].includes(record.job.status)) return;
  if (record.job.status === "processing" && Date.parse(record.job.leaseExpiresAt || "") > Date.now()) return;
  const context = { env } as AppContext;
  if (!await available(context, record.job, deps)) throw new Error("O pacote desta indexação não está mais disponível.");
  await sourceVersion(context, record.job);
  const token = crypto.randomUUID();
  const claimed: IntegrityJob = { ...record.job, status: "processing", phase: "indexing", attempts: Math.max(attempt, record.job.attempts + 1),
    leaseToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: new Date().toISOString() };
  delete claimed.error;
  const claim = await writeJob(env, claimed, record.etag);
  if (!claim) return;
  options.onClaim?.(token);
  record = { job: claimed, etag: claim.etag };
  const save = async (changes: Partial<IntegrityJob>) => {
    const current = await readJob(env, body.jobId);
    if (!current || current.job.queueGeneration !== body.generation || current.job.leaseToken !== token || current.job.status !== "processing") {
      throw new Error("A indexação foi cancelada ou substituída.");
    }
    const updated: IntegrityJob = { ...current.job, ...changes, updatedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
    const result = await writeJob(env, updated, current.etag);
    if (!result) throw new Error("A indexação mudou durante o checkpoint.");
    record = { job: updated, etag: result.etag };
  };
  await workerSeen(env).catch(() => {});
  const prefix = workPrefix(env, record.job);
  let plan: Plan;
  if (record.job.queuePlanKey) plan = await readJson<Plan>(env.CUSTOM_GAMES, record.job.queuePlanKey);
  else {
    if (record.job.packageType === "zip") {
      const result = await (options.planZip || planCloudflareZip)(env.CUSTOM_GAMES, record.job.archiveKey, record.job.sourceEtag, record.job.sourceSize);
      plan = { version: 1, ...result };
    } else {
      const folder = await deps.loadFolderManifest(context, record.job.archiveKey);
      if (folder.bundles?.length) throw new Error("Pasta em bundles deve publicar os hashes existentes.");
      plan = { version: 1, totalSizeBytes: folder.totalSizeBytes, files: folder.files };
    }
    const json = JSON.stringify(plan);
    if (encoder.encode(json).byteLength > MAX_PLAN_BYTES) throw new Error("Plano de indexação acima do limite.");
    const key = `${prefix}plan.json`;
    await env.CUSTOM_GAMES.put(key, json, { httpMetadata: { contentType: "application/json" } });
    await save({ queuePlanKey: key, totalFiles: plan.files.length, totalBytes: plan.totalSizeBytes });
  }
  if (plan.version !== 1 || !plan.files.length || plan.files.length > 100_000) throw new Error("Plano de indexação inválido.");
  const from = record.job.queueCursor || 0;
  if (!Number.isSafeInteger(from) || from < 0 || from > plan.files.length) throw new Error("Checkpoint de arquivo inválido.");
  let cursor = from;
  let processedBytes = plan.files.slice(0, from).reduce((total, file) => total + file.sizeBytes, 0);
  let lastProgress = Date.now();
  const started = Date.now();
  const results: IntegrityFile[] = [];
  while (cursor < plan.files.length && (cursor === from ||
    (cursor - from < (options.maxFiles || 32) && Date.now() - started < (options.maxMilliseconds || 45_000)))) {
    const entry = plan.files[cursor]!;
    const onProgress = async (bytes: number) => {
      if (Date.now() - lastProgress < 10_000) return;
      lastProgress = Date.now();
      await save({ processedBytes: processedBytes + bytes, processedFiles: cursor });
      await workerSeen(env).catch(() => {});
    };
    const file = record.job.packageType === "zip"
      ? await (options.hashZip || hashCloudflareZipEntry)(env.CUSTOM_GAMES, record.job.archiveKey, record.job.sourceEtag,
        record.job.sourceSize, entry as CloudflareZipEntry, { onProgress })
      : await (options.hashFolder || hashFolderFile)(env.CUSTOM_GAMES, entry as FolderEntry, onProgress);
    results.push(file); processedBytes += file.sizeBytes; cursor++;
  }
  if (results.length) {
    const part: Part = { from, to: cursor, files: results };
    await env.CUSTOM_GAMES.put(`${prefix}results/${String(from).padStart(8, "0")}.json`, JSON.stringify(part),
      { httpMetadata: { contentType: "application/json" } });
    await save({ queueCursor: cursor, processedBytes, processedFiles: cursor, attempts: 0 });
  }
  if (cursor < plan.files.length) {
    // Release before sending; if delivery/send is interrupted cron will redispatch.
    const current = await readJob(env, body.jobId);
    if (!current || current.job.queueGeneration !== body.generation || current.job.leaseToken !== token || current.job.status !== "processing") return;
    const next = { ...current.job, status: "queued" as const, phase: "indexing" as const };
    delete next.leaseToken; delete next.leaseExpiresAt;
    if (!await writeJob(env, next, current.etag)) return;
    await env.CUSTOM_GAME_INDEX_QUEUE!.send(body);
    return;
  }
  const files: IntegrityFile[] = [];
  let next = 0;
  while (next < plan.files.length) {
    const part = await readJson<Part>(env.CUSTOM_GAMES, `${prefix}results/${String(next).padStart(8, "0")}.json`);
    if (part.from !== next || !Number.isSafeInteger(part.to) || part.to <= next || part.to > plan.files.length || part.files.length !== part.to - next) {
      throw new Error("Sequência de checkpoints de integridade inválida.");
    }
    files.push(...part.files); next = part.to;
  }
  await sourceVersion(context, record.job);
  if (!await available(context, record.job, deps)) throw new Error("O pacote deixou de estar disponível durante a indexação.");
  const manifest = validateIntegrityManifest({ version: 1, gameId: record.job.gameId, archiveKey: record.job.archiveKey,
    totalSizeBytes: plan.totalSizeBytes, files, sourceEtag: record.job.sourceEtag, sourceSize: record.job.sourceSize,
    indexedAt: new Date().toISOString() }, { id: record.job.gameId, archive_key: record.job.archiveKey,
    archive_size: record.job.sourceSize, package_type: record.job.packageType }, deps);
  await save({ phase: "publishing" });
  await storeManifest(context, manifest);
  await save({ status: "completed", phase: "completed", indexedAt: manifest.indexedAt, fileCount: files.length,
    processedBytes: plan.totalSizeBytes, processedFiles: files.length, attempts: 0 });
  await workerSeen(env).catch(() => {});
}

export async function consumeCloudflareIntegrityBatch(batch: MessageBatch<IntegrityQueueMessage>, env: AppBindings,
  deps: IntegrityDependencies, options: ProcessorOptions = {}) {
  for (const message of batch.messages) {
    let ownedToken: string | undefined;
    try {
      await processCloudflareIntegrityMessage(env, message.body, deps, message.attempts, { ...options,
        onClaim: token => { ownedToken = token; options.onClaim?.(token); } });
      message.ack();
    } catch (error) {
      const body = message.body;
      if (body && ID.test(body.jobId) && UUID.test(body.generation)) {
        const record = await readJob(env, body.jobId);
        if (record && record.job.queueGeneration === body.generation && ["queued", "processing"].includes(record.job.status)
          && (ownedToken ? record.job.leaseToken === ownedToken : record.job.status === "queued")) {
          const failed = Math.max(message.attempts, record.job.attempts) >= 4;
          const job: IntegrityJob = { ...record.job, status: failed ? "failed" : "queued", phase: failed ? "failed" : "indexing",
            updatedAt: new Date().toISOString(), error: (error instanceof Error ? error.message : "Falha de indexação na Cloudflare.").slice(0, 500) };
          delete job.leaseToken; delete job.leaseExpiresAt;
          await writeJob(env, job, record.etag);
        }
      }
      console.warn("[CustomGamesIntegrity] queue-attempt-failed", { jobId: body?.jobId, attempt: message.attempts });
      message.retry({ delaySeconds: 30 });
    }
  }
}
