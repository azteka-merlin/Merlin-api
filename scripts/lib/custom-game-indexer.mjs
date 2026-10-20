import { createHash } from "node:crypto";
import { open, mkdtemp, mkdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

const GiB = 1024 ** 3;
export const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 100 * GiB,
  maxGameBytes: 200 * GiB,
  maxFileBytes: 30 * GiB,
  maxFiles: 100_000,
  maxEntries: 200_000,
  maxCompressionRatio: 10_000,
  reserveDiskBytes: GiB,
});
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const MAX_RANGE_BYTES = 64 * 1024 ** 2;

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} inválido ou acima do limite.`);
  return value;
}

function checkAbort(signal) { signal?.throwIfAborted(); }

export function validateFilePath(value, { directory = false } = {}) {
  if (typeof value !== "string") throw new Error("Caminho de arquivo inválido.");
  // Backslashes are accepted by the current folder uploader and normalized to
  // the exact same slash-separated paths used in the launcher's manifest.
  let name = value.replace(/\\/g, "/");
  if (directory && name.endsWith("/")) name = name.slice(0, -1);
  const segments = name.split("/");
  if (!name || name.length > 500 || name.startsWith("/") || segments.length > 32 || segments.some(part =>
    !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f\x7f]/.test(part) ||
    /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) ||
    part.toLowerCase() === ".merlin-install.json" || part.includes("\ufffd"))) {
    throw new Error("O pacote contém um caminho de arquivo inválido.");
  }
  return name;
}

function pathRegistry() {
  const files = new Set();
  const declared = new Set();
  const canonical = new Map();
  return (name, directory = false) => {
    const parts = name.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length; index++) {
      prefix += `${index ? "/" : ""}${parts[index]}`;
      const key = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = canonical.get(key);
      if (prior && prior !== prefix) throw new Error("O pacote contém caminhos com diferenças apenas de caixa ou Unicode.");
      if (index < parts.length - 1 && files.has(key)) throw new Error("O pacote contém conflito entre arquivo e pasta.");
      if (index === parts.length - 1) {
        if (declared.has(key)) throw new Error("O pacote contém caminhos duplicados.");
        if (!directory && canonical.has(key)) throw new Error("O pacote contém conflito entre arquivo e pasta.");
        declared.add(key);
        if (!directory) files.add(key);
      }
      canonical.set(key, prefix);
    }
  };
}

function mergedLimits(limits) {
  const result = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(result)) {
    if (key === "maxCompressionRatio") {
      if (!Number.isFinite(value) || value < 1) throw new Error("Limite de compressão inválido.");
    } else integer(value, key);
  }
  return result;
}

function openZip(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, autoClose: false, decodeStrings: true,
      validateEntrySizes: true, strictFileNames: false }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function closeZip(zip) {
  if (!zip.isOpen) return;
  await new Promise(resolve => { zip.once("close", resolve); zip.close(); });
}

function validZipEntry(entry, limits) {
  const directory = entry.fileName.endsWith("/");
  const name = validateFilePath(entry.fileName, { directory });
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x400)) {
    throw new Error("Links simbólicos, atalhos de sistema e arquivos especiais não são permitidos no ZIP.");
  }
  if ((entry.externalFileAttributes & 0x10) && !directory) throw new Error("Diretório ZIP com nome inválido.");
  if (entry.generalPurposeBitFlag & (1 | 64 | 8192)) throw new Error("ZIP criptografado não é suportado.");
  if (![0, 8].includes(entry.compressionMethod)) throw new Error("O ZIP deve usar compressão stored ou deflate.");
  integer(entry.uncompressedSize, "Tamanho do arquivo", limits.maxFileBytes);
  integer(entry.compressedSize, "Tamanho comprimido", limits.maxArchiveBytes);
  integer(entry.relativeOffsetOfLocalHeader, "Posição do arquivo", limits.maxArchiveBytes);
  if (directory && (entry.uncompressedSize || entry.crc32 !== 0)) throw new Error("Diretório ZIP contém dados.");
  if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.maxCompressionRatio) {
    throw new Error("A taxa de compressão do ZIP ultrapassa o limite configurado.");
  }
  return { path: name, directory, sizeBytes: entry.uncompressedSize };
}

async function zipPayloadLocation(handle, entry, archiveSize) {
  const header = Buffer.alloc(30);
  const read = await handle.read(header, 0, 30, entry.relativeOffsetOfLocalHeader);
  if (read.bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(6) !== entry.generalPurposeBitFlag || header.readUInt16LE(8) !== entry.compressionMethod) {
    throw new Error("Cabeçalho local do ZIP diverge do diretório central.");
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const rawName = Buffer.alloc(nameLength);
  const nameRead = await handle.read(rawName, 0, nameLength, entry.relativeOffsetOfLocalHeader + 30);
  if (nameRead.bytesRead !== nameLength || (entry.fileNameRaw && !rawName.equals(entry.fileNameRaw))) {
    throw new Error("Nome local do ZIP diverge do diretório central.");
  }
  const offset = entry.relativeOffsetOfLocalHeader + 30 + nameLength + extraLength;
  if (!Number.isSafeInteger(offset) || offset + entry.compressedSize > archiveSize) throw new Error("Dados do ZIP ultrapassam os limites do arquivo.");
  return { offset, compressedSize: entry.compressedSize, method: entry.compressionMethod, crc32: entry.crc32 };
}

/** Iterate lazily without retaining Entry extra fields and comments in memory. */
async function walkZip(filename, visitor, signal) {
  checkAbort(signal);
  const zip = await openZip(filename);
  let fatal;
  // Keep the listener installed while decompressing entries as well: malformed
  // file descriptors can emit an error outside the next-entry promise.
  const rememberError = error => { fatal ||= error; };
  zip.on("error", rememberError);
  try {
    while (true) {
      checkAbort(signal);
      if (fatal) throw fatal;
      const entry = await new Promise((resolve, reject) => {
        const cleanup = () => {
          zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        const onEntry = value => { cleanup(); resolve(value); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onError = error => { cleanup(); reject(error); };
        const onAbort = () => { cleanup(); reject(signal.reason); };
        zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
        zip.readEntry();
      });
      if (!entry) break;
      await visitor(entry, zip);
    }
    if (fatal) throw fatal;
  } finally {
    await closeZip(zip);
    zip.off("error", rememberError);
  }
}

/** SHA-256 + CRC of every decompressed regular file, never extracting to disk. */
export async function indexZip(filename, { limits: suppliedLimits, signal, onProgress = () => {} } = {}) {
  const limits = mergedLimits(suppliedLimits);
  const info = await stat(filename);
  integer(info.size, "Tamanho do ZIP", limits.maxArchiveBytes);
  const register = pathRegistry();
  const files = [];
  let entries = 0;
  let totalSizeBytes = 0;
  // Only the bounded path/hash manifest is kept in RAM. Reading metadata a
  // second time locally avoids retaining yauzl's potentially large extra fields.
  const handle = await open(filename, "r");
  try { await walkZip(filename, async entry => {
    if (++entries > limits.maxEntries) throw new Error("O ZIP excede o limite de entradas.");
    const item = validZipEntry(entry, limits);
    register(item.path, item.directory);
    if (item.directory) return;
    if (files.length >= limits.maxFiles) throw new Error("O ZIP excede o limite de arquivos.");
    totalSizeBytes = integer(totalSizeBytes + item.sizeBytes, "Tamanho descompactado", limits.maxGameBytes);
    const zip = await zipPayloadLocation(handle, entry, info.size);
    files.push({ path: item.path, sizeBytes: item.sizeBytes, sha256: "", zip });
  }, signal); } finally { await handle.close(); }
  if (!files.length) throw new Error("O ZIP não contém arquivos de jogo.");
  let processedFiles = 0;
  let processedBytes = 0;
  onProgress({ phase: "indexing", processedBytes, totalBytes: totalSizeBytes, processedFiles, totalFiles: files.length });
  await walkZip(filename, async (entry, zip) => {
    const item = validZipEntry(entry, limits);
    if (item.directory) {
      // Python and other conforming writers may deflate an empty directory;
      // the compressed empty stream is nonempty even though its content is not.
      const stream = await entryStream(zip, entry);
      const abort = () => stream.destroy(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        checkAbort(signal);
        for await (const chunk of stream) {
          checkAbort(signal);
          if (chunk.length) throw new Error("Diretório ZIP contém dados.");
        }
      } finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
      return;
    }
    const expected = files[processedFiles];
    if (!expected || expected.path !== item.path || expected.sizeBytes !== item.sizeBytes) throw new Error("O ZIP mudou durante a indexação.");
    const stream = await entryStream(zip, entry);
    const abort = () => stream.destroy(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const hash = createHash("sha256");
    let checksum = 0;
    let fileBytes = 0;
    try {
      checkAbort(signal);
      for await (const chunk of stream) {
        checkAbort(signal);
        fileBytes += chunk.length;
        if (fileBytes > expected.sizeBytes) throw new Error("O ZIP contém tamanho descompactado incorreto.");
        checksum = crc32(chunk, checksum);
        hash.update(chunk);
        processedBytes += chunk.length;
        onProgress({ phase: "indexing", processedBytes, totalBytes: totalSizeBytes, processedFiles, totalFiles: files.length });
      }
      if (fileBytes !== expected.sizeBytes) throw new Error("Arquivo ZIP incompleto.");
      if (checksum !== entry.crc32) throw new Error("CRC32 do ZIP não corresponde ao conteúdo do arquivo.");
      expected.sha256 = hash.digest("hex");
      processedFiles++;
      onProgress({ phase: "indexing", processedBytes, totalBytes: totalSizeBytes, processedFiles, totalFiles: files.length });
    } finally {
      signal?.removeEventListener("abort", abort);
      stream.destroy();
    }
  }, signal);
  return { files, totalSizeBytes };
}

export class IndexerHttpError extends Error {
  constructor(status) {
    super(`API de indexação respondeu HTTP ${status}.`);
    this.status = status;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export class IndexerClient {
  constructor({ apiUrl, secret, fetchImpl = fetch, requestTimeoutMs = 60_000, requestRetries = 3, retryDelayMs = 1000 }) {
    const base = new URL(apiUrl);
    if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
      throw new Error("CUSTOM_GAME_INDEXER_API_URL deve ser HTTPS (HTTP permitido apenas em localhost).");
    }
    if (!secret || /[\r\n]/.test(secret)) throw new Error("CUSTOM_GAME_INDEXER_SECRET é obrigatório.");
    this.baseUrl = `${base.href.replace(/\/$/, "")}/internal/custom-game-indexing`;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.timeoutMs = requestTimeoutMs;
    this.retries = requestRetries;
    this.retryDelayMs = retryDelayMs;
  }

  async request(suffix, { method = "POST", body, headers = {}, signal, retries = this.retries, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      try {
        const response = await this.fetch(`${this.baseUrl}${suffix}`, {
          method, redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
          headers: { authorization: `Bearer ${this.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new IndexerHttpError(response.status);
        }
        return response;
      } catch (error) {
        checkAbort(signal);
        if (attempt >= retries || (error instanceof IndexerHttpError && !error.retryable)) throw error;
        await delay(Math.min(10_000, this.retryDelayMs * 2 ** attempt), undefined, { signal });
      }
    }
  }

  async post(suffix, body, signal, options = {}) {
    const retries = options.retries ?? this.retries;
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      try {
        const response = await this.request(suffix, { body, signal, ...options, retries: 0 });
        const chunks = [];
        let size = 0;
        // Claim responses can contain a legacy folder's path descriptors, but
        // never read an unbounded response into RAM. The original request's
        // abort timeout remains attached while reading its body.
        for await (const chunk of response.body || []) {
          size += chunk.byteLength;
          if (size > 16 * 1024 ** 2) throw new Error("Resposta da API de indexação acima do limite.");
          chunks.push(Buffer.from(chunk));
        }
        if (!size) return {};
        try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
        catch { throw new Error("Resposta JSON inválida da API de indexação."); }
      } catch (error) {
        checkAbort(signal);
        if (attempt >= retries || (error instanceof IndexerHttpError && !error.retryable)) throw error;
        // Retry acknowledgement loss as well as failure to receive headers.
        // All retried POSTs are idempotent; claim explicitly sets retries=0.
        await delay(Math.min(10_000, this.retryDelayMs * 2 ** attempt), undefined, { signal });
      }
    }
  }

  sourceSuffix(job, fileIndex) {
    return `/${encodeURIComponent(job.id)}/source${fileIndex === undefined ? "" : `?file=${fileIndex}`}`;
  }

  async headSource(job, expectedSize, signal, fileIndex) {
    const response = await this.request(this.sourceSuffix(job, fileIndex), { method: "HEAD", signal,
      headers: { "x-index-lease": job.leaseToken, "accept-encoding": "identity" } });
    if (response.headers.get("content-length") !== String(expectedSize)) throw new Error("O tamanho da origem mudou desde o enfileiramento.");
    const expectedEtag = fileIndex === undefined ? job.sourceEtag : job.files[fileIndex].etag;
    if (expectedEtag && stripEtag(response.headers.get("etag")) !== stripEtag(expectedEtag)) {
      throw new Error("A versão da origem mudou desde o enfileiramento.");
    }
    const etag = stripEtag(response.headers.get("etag"));
    if (!etag) throw new Error("A origem não forneceu um ETag para fixar sua versão.");
    return etag;
  }

  /** Consume bounded ranges; retry from the last byte actually written/hashed. */
  async readSource(job, { sizeBytes, fileIndex, signal, rangeBytes = 16 * 1024 ** 2, consume }) {
    integer(rangeBytes, "Tamanho do intervalo", MAX_RANGE_BYTES);
    if (!rangeBytes) throw new Error("O tamanho do intervalo deve ser maior que zero.");
    const pinnedEtag = await this.headSource(job, sizeBytes, signal, fileIndex);
    let position = 0;
    let failures = 0;
    while (position < sizeBytes) {
      checkAbort(signal);
      const start = position;
      const end = Math.min(sizeBytes, start + rangeBytes) - 1;
      let response;
      try {
        response = await this.request(this.sourceSuffix(job, fileIndex), { method: "GET", signal, retries: 0,
          headers: { "x-index-lease": job.leaseToken, "if-match": `"${pinnedEtag}"`, range: `bytes=${start}-${end}`, "accept-encoding": "identity" } });
        if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${sizeBytes}` ||
          (response.headers.has("content-length") && response.headers.get("content-length") !== String(end - start + 1)) ||
          (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")) {
          throw new IndexerHttpError(422);
        }
        if (stripEtag(response.headers.get("etag")) !== pinnedEtag) {
          throw new IndexerHttpError(409);
        }
        if (!response.body) throw new Error("A origem não retornou conteúdo.");
        for await (const chunk of response.body) {
          checkAbort(signal);
          if (position + chunk.byteLength > end + 1) throw new IndexerHttpError(422);
          await consume(Buffer.from(chunk), position);
          position += chunk.byteLength;
        }
        if (position !== end + 1) throw new Error("Intervalo recebido incompleto.");
        failures = 0;
      } catch (error) {
        try { await response?.body?.cancel(); } catch { /* May already be closed or locked. */ }
        checkAbort(signal);
        if ((error instanceof IndexerHttpError && !error.retryable) || ++failures > this.retries) throw error;
        await delay(Math.min(10_000, this.retryDelayMs * 2 ** (failures - 1)), undefined, { signal });
      }
    }
  }
}

function stripEtag(value) { return String(value || "").replace(/^"|"$/g, ""); }

/** Independent timer keeps leases alive during slow HTTP or decompression. */
class JobProgress {
  constructor(client, job, signal, { heartbeatMs = 15_000, onLog = () => {} } = {}) {
    if (heartbeatMs < 10 || heartbeatMs > 30_000) throw new Error("Heartbeat deve ocorrer no máximo a cada 30 segundos.");
    this.client = client;
    this.job = job;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.state = { phase: job.packageType === "zip" ? "downloading" : "indexing", processedBytes: 0,
      totalBytes: job.packageType === "zip" ? job.sourceSize : job.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      processedFiles: 0, totalFiles: job.packageType === "zip" ? 0 : job.files.length };
    this.heartbeatMs = heartbeatMs;
    this.onLog = onLog;
  }

  update = state => { this.state = { ...state }; };

  async send() {
    if (this.pending) return this.pending;
    const snapshot = { ...this.state };
    this.pending = this.client.post(`/${encodeURIComponent(this.job.id)}/progress`,
      { leaseToken: this.job.leaseToken, ...snapshot }, this.signal, { retries: 1, timeoutMs: 15_000 })
      .then(() => this.onLog({ jobId: this.job.id, ...snapshot }))
      .catch(error => { this.controller.abort(error); throw error; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async start() {
    await this.send();
    this.timer = setInterval(() => { this.send().catch(() => {}); }, this.heartbeatMs);
  }

  async flush() { if (this.pending) await this.pending; await this.send(); }

  async stop() {
    clearInterval(this.timer);
    if (this.pending) { try { await this.pending; } catch { /* Job path reports the failure. */ } }
  }
}

function validateJob(job, limits) {
  if (!job || typeof job.id !== "string" || typeof job.gameId !== "string" || !job.leaseToken ||
    typeof job.archiveKey !== "string" || !["zip", "folder"].includes(job.packageType)) throw new Error("Job de indexação inválido.");
  if (job.packageType === "zip") integer(job.sourceSize, "Tamanho da origem", limits.maxArchiveBytes);
  else {
    if (!Array.isArray(job.files) || !job.files.length || job.files.length > limits.maxFiles) throw new Error("Lista de arquivos da pasta inválida.");
    const register = pathRegistry();
    let total = 0;
    for (const file of job.files) {
      if (typeof file.key !== "string") throw new Error("Chave de arquivo da pasta inválida.");
      file.path = validateFilePath(file.path);
      register(file.path);
      total = integer(total + integer(file.sizeBytes, "Tamanho do arquivo", limits.maxFileBytes), "Tamanho da pasta", limits.maxGameBytes);
      if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error("SHA-256 da pasta inválido.");
    }
  }
}

export async function processIndexJob(client, job, { signal = new AbortController().signal, limits: suppliedLimits,
  tempRoot = tmpdir(), rangeBytes, heartbeatMs = 15_000, onLog } = {}) {
  const limits = mergedLimits(suppliedLimits);
  validateJob(job, limits);
  const progress = new JobProgress(client, job, signal, { heartbeatMs, onLog });
  let tempDirectory;
  try {
    await progress.start();
    const workSignal = progress.signal;
    let index;
    let archiveSha256;
    if (job.packageType === "zip") {
      await mkdir(tempRoot, { recursive: true });
      tempDirectory = await mkdtemp(path.join(tempRoot, "merlin-index-"));
      const disk = await statfs(tempDirectory, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(job.sourceSize) + BigInt(limits.reserveDiskBytes)) {
        throw new Error("Disco temporário sem espaço para o ZIP completo e a reserva configurada.");
      }
      const filename = path.join(tempDirectory, "source.zip");
      const destination = await open(filename, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        await client.readSource(job, { sizeBytes: job.sourceSize, signal: workSignal, rangeBytes,
          consume: async (chunk, position) => {
            // FileHandle.write may write fewer bytes than requested.
            let written = 0;
            while (written < chunk.length) {
              const result = await destination.write(chunk, written, chunk.length - written, position + written);
              if (!result.bytesWritten) throw new Error("Não foi possível gravar o ZIP temporário.");
              written += result.bytesWritten;
            }
            hash.update(chunk);
            progress.update({ phase: "downloading", processedBytes: position + chunk.length, totalBytes: job.sourceSize,
              processedFiles: 0, totalFiles: 0 });
          } });
      } finally { await destination.close(); }
      archiveSha256 = hash.digest("hex");
      await progress.flush();
      index = await indexZip(filename, { limits, signal: workSignal, onProgress: progress.update });
    } else {
      const files = [];
      const totalSizeBytes = job.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      let processedBytes = 0;
      for (let fileIndex = 0; fileIndex < job.files.length; fileIndex++) {
        const file = job.files[fileIndex];
        const hash = createHash("sha256");
        await client.readSource(job, { sizeBytes: file.sizeBytes, fileIndex, signal: workSignal, rangeBytes,
          consume: async chunk => {
            hash.update(chunk); processedBytes += chunk.length;
            progress.update({ phase: "indexing", processedBytes, totalBytes: totalSizeBytes, processedFiles: fileIndex, totalFiles: job.files.length });
          } });
        const sha256 = hash.digest("hex");
        if (file.sha256 && file.sha256.toLowerCase() !== sha256) throw new Error("SHA-256 da origem não corresponde ao manifesto existente.");
        if (!file.sizeBytes && sha256 !== EMPTY_SHA256) throw new Error("SHA-256 de arquivo vazio inválido.");
        files.push({ path: file.path, sizeBytes: file.sizeBytes, sha256 });
        progress.update({ phase: "indexing", processedBytes, totalBytes: totalSizeBytes, processedFiles: fileIndex + 1, totalFiles: job.files.length });
      }
      index = { files, totalSizeBytes };
    }
    await progress.flush();
    // A timer must not race completion and mistake a completed lease for a
    // failure. The just-renewed lease leaves enough time for completion retries.
    await progress.stop();
    checkAbort(progress.signal);
    const manifest = { version: 1, gameId: job.gameId, archiveKey: job.archiveKey,
      ...index, ...(archiveSha256 ? { archiveSha256 } : {}) };
    await client.post(`/${encodeURIComponent(job.id)}/complete`, { leaseToken: job.leaseToken, manifest }, progress.signal);
    return manifest;
  } finally {
    await progress.stop();
    if (tempDirectory) {
      const root = path.resolve(tempRoot);
      const target = path.resolve(tempDirectory);
      if (path.dirname(target) !== root || !path.basename(target).startsWith("merlin-index-")) throw new Error("Pasta temporária fora do diretório esperado.");
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export function configurationFromEnv(env = process.env) {
  if (!env.CUSTOM_GAME_INDEXER_API_URL) throw new Error("Defina CUSTOM_GAME_INDEXER_API_URL com a origem da API Merlin.");
  if (!env.CUSTOM_GAME_INDEXER_SECRET) throw new Error("Defina CUSTOM_GAME_INDEXER_SECRET com o segredo do indexador.");
  const readInteger = (name, fallback) => env[name] === undefined ? fallback : integer(Number(env[name]), name);
  const limits = {
    maxArchiveBytes: readInteger("CUSTOM_GAME_INDEXER_MAX_ARCHIVE_BYTES", DEFAULT_LIMITS.maxArchiveBytes),
    maxGameBytes: readInteger("CUSTOM_GAME_INDEXER_MAX_GAME_BYTES", DEFAULT_LIMITS.maxGameBytes),
    maxFileBytes: readInteger("CUSTOM_GAME_INDEXER_MAX_FILE_BYTES", DEFAULT_LIMITS.maxFileBytes),
    reserveDiskBytes: readInteger("CUSTOM_GAME_INDEXER_RESERVE_DISK_BYTES", DEFAULT_LIMITS.reserveDiskBytes),
  };
  const rangeBytes = readInteger("CUSTOM_GAME_INDEXER_RANGE_BYTES", 16 * 1024 ** 2);
  if (!rangeBytes || rangeBytes > MAX_RANGE_BYTES) throw new Error("CUSTOM_GAME_INDEXER_RANGE_BYTES deve ficar entre 1 byte e 64 MiB.");
  const pollMs = readInteger("CUSTOM_GAME_INDEXER_POLL_MS", 15_000);
  if (pollMs < 1000) throw new Error("CUSTOM_GAME_INDEXER_POLL_MS deve ser ao menos 1000.");
  return { apiUrl: env.CUSTOM_GAME_INDEXER_API_URL, secret: env.CUSTOM_GAME_INDEXER_SECRET,
    tempRoot: env.CUSTOM_GAME_INDEXER_TEMP_DIR || tmpdir(), limits, rangeBytes, pollMs };
}

export function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : "Falha desconhecida na indexação.";
  for (const secret of secrets) if (secret) message = message.split(String(secret)).join("[redacted]");
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 800);
}

export async function runIndexer({ client, once = false, signal = new AbortController().signal,
  pollMs = 15_000, log = record => console.log(JSON.stringify({ at: new Date().toISOString(), ...record })), ...options }) {
  let failures = 0;
  while (!signal.aborted) {
    let job;
    try {
      // Claims are deliberately not retried in place: a lost claim response
      // leaves its unobserved lease to expire rather than claiming a second job.
      ({ job } = await client.post("/claim", {}, signal, { retries: 0 }));
      if (job) {
        log({ event: "claimed", jobId: job.id, gameId: job.gameId, packageType: job.packageType });
        await processIndexJob(client, job, { ...options, signal, onLog: progress => log({ event: "progress", ...progress }) });
        log({ event: "completed", jobId: job.id, gameId: job.gameId });
      }
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      const message = safeError(error, [client.secret, job?.leaseToken]);
      log({ event: "failed", ...(job ? { jobId: job.id, gameId: job.gameId } : {}), error: message });
      if (job) {
        try { await client.post(`/${encodeURIComponent(job.id)}/fail`, { leaseToken: job.leaseToken, error: message }, signal); }
        catch (failure) { log({ event: "failure_report_failed", jobId: job.id, error: safeError(failure, [client.secret, job.leaseToken]) }); }
      }
      failures++;
      if (once || (error instanceof IndexerHttpError && [401, 403].includes(error.status))) throw new Error(message);
    }
    if (once) return;
    if (job && !failures) continue;
    try { await delay(Math.min(60_000, pollMs * Math.max(1, 2 ** Math.min(failures, 3))), undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
