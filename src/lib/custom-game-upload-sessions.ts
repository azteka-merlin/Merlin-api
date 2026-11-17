import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AwsClient } from "aws4fetch";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { MAX_FOLDER_GAME_FILES } from "./custom-game-limits";

const PART_SIZE = 64 * 1024 ** 2;
const MAX_OBJECT_SIZE = 30 * 1024 ** 3;
const SESSION_TTL_MS = 7 * 86400_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9_:-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JSON_METADATA = { httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" } };
const MAX_FOLDER_SIZE = 200 * 1024 ** 3;
const MAX_BUNDLE_SIZE = 200 * 1024 ** 2;
const MAX_BUNDLE_MEMBER_SIZE = 200 * 1024 ** 2;
const MAX_METADATA_INDEX_BYTES = 8 * 1024 ** 2;
const MAX_METADATA_OBJECTS = 10_000;
const MAX_FINALIZATION_BATCHES_PER_REQUEST = 32;
const MAX_FINALIZATION_OBJECTS_PER_REQUEST = 400;

type SessionState = "open" | "finalizing" | "finalized" | "cancelled";
export type GameUploadSession = {
  version: 1; id: string; adminId: number; gameId: string; fingerprint: string; planVersion: 2;
  status: SessionState; createdAt: number; expiresAt: number; finalizingAt?: number; manifestId?: string; manifestKey?: string;
};
export type GameUploadCheckpoint = {
  clientId: string; key: string; filename: string; sizeBytes: number; uploadId?: string;
  sha256?: string; completed: boolean; etag?: string; createdAt: number;
  state: "initiating" | "uploading" | "completed";
};
type Stored<T> = { value: T; etag: string };

function fail(message: string, status: 400 | 404 | 409 | 503 = 400): never {
  throw new HTTPException(status, { message });
}
function sessionKey(id: string) { return `_upload-sessions/${id}/session.json`; }
function expiryKey(session: GameUploadSession) { return `_upload-session-expiry/${session.expiresAt}-${session.id}.json`; }
function checkpointKey(id: string, clientId: string) { return `_upload-sessions/${id}/objects/${clientId}.json`; }
function metadataBatchKey(id: string, manifestId: string, index: number) {
  return `_upload-sessions/${id}/metadata/${manifestId}/${String(index).padStart(6, "0")}.json`;
}
function uuid(value: unknown) { const id = String(value || ""); if (!UUID.test(id)) fail("Sessão de upload inválida."); return id; }
function client(value: unknown) { const id = String(value || ""); if (!CLIENT_ID.test(id)) fail("Objeto de upload inválido."); return id; }
function sha(value: unknown) { const result = String(value || "").toLowerCase(); if (!SHA256.test(result)) fail("Hash SHA-256 inválido."); return result; }

async function read<T>(bucket: R2Bucket, key: string): Promise<Stored<T> | null> {
  const object = await bucket.get(key);
  return object ? { value: await object.json<T>(), etag: object.etag } : null;
}
async function replace<T>(bucket: R2Bucket, key: string, value: T, etag: string) {
  const stored = await bucket.put(key, JSON.stringify(value), { ...JSON_METADATA, onlyIf: { etagMatches: etag } });
  if (!stored) fail("O estado do upload mudou. Atualize e tente novamente.", 409);
  return stored;
}
async function authenticate(c: AppContext, mutate = true) {
  c.header("cache-control", "private, no-store");
  const result = await requireAdminSession(c, { mutate, touch: false });
  return result.session.admin_user_id;
}
async function getSession(c: AppContext, id: string, adminId: number, allowExpired = false) {
  const stored = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(uuid(id)));
  if (!stored || stored.value.adminId !== adminId) fail("Sessão de upload não encontrada.", 404);
  if (!allowExpired && stored.value.status === "open" && stored.value.expiresAt <= Date.now()) {
    fail("Esta sessão de upload expirou. Inicie um novo envio.", 409);
  }
  return stored;
}
function requireOpen(session: GameUploadSession) {
  if (session.status !== "open") fail("Esta sessão de upload não aceita mais arquivos.", 409);
}
async function limitedRequestBytes(c: AppContext, limit: number) {
  const declared = c.req.header("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail("Lote de metadados acima do limite.");
  const body = c.req.raw.body;
  if (!body) fail("Lote de metadados obrigatório.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        fail("Lote de metadados acima do limite.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function checkpoint(c: AppContext, session: GameUploadSession, clientId: string) {
  const stored = await read<GameUploadCheckpoint>(c.env.CUSTOM_GAMES, checkpointKey(session.id, client(clientId)));
  if (!stored) fail("Objeto desta sessão não encontrado.", 404);
  return stored;
}
async function checkpointsByClient(c: AppContext, session: GameUploadSession, clientIds: string[], concurrency = 16) {
  const ids = [...new Set(clientIds)];
  const result = new Map<string, GameUploadCheckpoint>();
  for (let offset = 0; offset < ids.length; offset += concurrency) {
    const batch = ids.slice(offset, offset + concurrency);
    const values = await Promise.all(batch.map(async id => [id, (await checkpoint(c, session, id)).value] as const));
    for (const [id, value] of values) result.set(id, value);
  }
  return result;
}
function isMissingMultipartPartError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\(10025\)|InvalidPart|não reconheceu uma ou mais partes/i.test(message);
}
async function restartGameMultipart(bucket: R2Bucket, session: GameUploadSession,
  entry: GameUploadCheckpoint, stored: Stored<GameUploadCheckpoint>) {
  await bucket.resumeMultipartUpload(entry.key, entry.uploadId!).abort().catch(() => {});
  const upload = await bucket.createMultipartUpload(entry.key, {
    customMetadata: { uploadSessionId: session.id, clientId: entry.clientId },
    httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
  });
  const replacement: GameUploadCheckpoint = { ...entry, uploadId: upload.uploadId, completed: false,
    state: "uploading", etag: undefined };
  try {
    await replace(bucket, checkpointKey(session.id, entry.clientId), replacement, stored.etag);
  } catch (error) {
    await bucket.resumeMultipartUpload(entry.key, upload.uploadId).abort().catch(() => {});
    throw error;
  }
  return replacement;
}
async function checkpoints(bucket: R2Bucket, sessionId: string) {
  const result: GameUploadCheckpoint[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `_upload-sessions/${sessionId}/objects/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    // The small JSON checkpoints contain only one entry each. Read with bounded concurrency.
    for (let offset = 0; offset < page.objects.length; offset += 12) {
      const values = await Promise.all(page.objects.slice(offset, offset + 12).map(object => read<GameUploadCheckpoint>(bucket, object.key)));
      for (const value of values) if (value) result.push(value.value);
    }
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) fail("Não foi possível recuperar o progresso do upload.", 409);
    cursor = page.cursor;
  } while (result.length <= 20000);
  return result;
}

export function customGamesR2Origin(env: AppBindings): string | null {
  return /^[a-f0-9]{32}$/.test(env.CUSTOM_GAMES_R2_ACCOUNT_ID || "")
    ? `https://${env.CUSTOM_GAMES_R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
}
function directConfig(env: AppBindings) {
  const origin = customGamesR2Origin(env);
  const bucket = env.CUSTOM_GAMES_R2_BUCKET || "custom-games";
  return origin && env.CUSTOM_GAMES_R2_ACCESS_KEY_ID && env.CUSTOM_GAMES_R2_SECRET_ACCESS_KEY &&
    /^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)
    ? { origin, bucket, accessKeyId: env.CUSTOM_GAMES_R2_ACCESS_KEY_ID, secretAccessKey: env.CUSTOM_GAMES_R2_SECRET_ACCESS_KEY } : null;
}
function responseSession(c: AppContext, session: GameUploadSession, objects: GameUploadCheckpoint[]) {
  return { success: true, sessionId: session.id, gameId: session.gameId, fingerprint: session.fingerprint,
    status: session.status, expiresAt: session.expiresAt, manifestId: session.manifestId, manifestKey: session.manifestKey,
    transport: directConfig(c.env) ? "direct" : "proxy", partSize: PART_SIZE, objects };
}

export async function completeGameMultipart(bucket: R2Bucket, key: string, uploadId: string,
  parts: { partNumber: number; etag: string }[], sizeBytes: number) {
  // R2 complete may succeed while its HTTP response is lost. A subsequent HEAD
  // recognizes that exact server-generated object instead of completing twice.
  let object = await bucket.head(key);
  if (!object) {
    try { object = await bucket.resumeMultipartUpload(key, uploadId).complete(parts); }
    catch (error) {
      object = await bucket.head(key);
      if (!object) {
        const message = error instanceof Error ? error.message : String(error);
        if (/\(10025\)|InvalidPart/i.test(message)) {
          fail("O R2 não reconheceu uma ou mais partes deste arquivo. Mantenha a pasta selecionada e tente enviar novamente.", 409);
        }
        throw error;
      }
    }
    object ||= await bucket.head(key);
  }
  if (!object || object.size !== sizeBytes) fail("O tamanho do arquivo enviado não confere.", 409);
  return object;
}

function validateParts(value: unknown, sizeBytes: number) {
  if (!Array.isArray(value) || value.length !== Math.ceil(sizeBytes / PART_SIZE)) fail("Partes do arquivo inválidas.");
  return value.map((part, index) => {
    if (!part || part.partNumber !== index + 1 || typeof part.etag !== "string") fail("Partes do arquivo inválidas.");
    // Presigned S3 UploadPart returns an HTTP ETag with surrounding quotes,
    // while the Workers R2 API expects the opaque R2UploadedPart.etag value.
    const etag = part.etag.startsWith('"') && part.etag.endsWith('"') ? part.etag.slice(1, -1) : part.etag;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(etag)) fail("Partes do arquivo inválidas.");
    return { partNumber: part.partNumber, etag };
  });
}

export async function beginGameUploadFinalization(c: AppContext, sessionId: string, adminId: number,
  gameId: string, manifestId: string, objects: { key: string; sizeBytes: number; sha256?: string }[]) {
  const stored = await getSession(c, sessionId, adminId);
  const session = stored.value;
  if (session.gameId !== gameId || session.status === "cancelled" ||
      (session.manifestId && session.manifestId !== manifestId)) fail("Pacote não pertence à sessão de upload.", 409);
  const entries = await checkpoints(c.env.CUSTOM_GAMES, sessionId);
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  if (entries.length !== objects.length || objects.some(object => {
    const entry = byKey.get(object.key);
    return !entry?.completed || entry.sizeBytes !== object.sizeBytes || entry.sha256 !== object.sha256;
  })) fail("Ainda existem arquivos incompletos nesta sessão.", 409);
  if (session.status === "open") {
    session.status = "finalizing"; session.finalizingAt = Date.now(); session.manifestId = manifestId;
    await replace(c.env.CUSTOM_GAMES, sessionKey(sessionId), session, stored.etag);
  }
  return session;
}
export async function finishGameUploadFinalization(c: AppContext, session: GameUploadSession, manifestKey: string) {
  const current = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(session.id));
  if (!current) fail("Estado da sessão inválido.", 409);
  if (current.value.status === "cancelled") {
    const referenced = await c.env.merlin_db.prepare(`SELECT id FROM custom_games WHERE archive_key=?
      UNION ALL SELECT game_id AS id FROM custom_game_versions WHERE archive_key=? AND status!='deleted' LIMIT 1`)
      .bind(manifestKey, manifestKey).first();
    if (!referenced) await c.env.CUSTOM_GAMES.delete(manifestKey);
    fail("A sessão foi descartada antes da finalização do pacote.", 409);
  }
  if (!["finalizing", "finalized"].includes(current.value.status)) fail("Estado da sessão inválido.", 409);
  if (current.value.status === "finalized") {
    if (current.value.manifestKey !== manifestKey) fail("Pacote já finalizado.", 409);
    return;
  }
  await replace(c.env.CUSTOM_GAMES, sessionKey(session.id), { ...current.value, status: "finalized", manifestKey }, current.etag);
  console.log("[CustomGamesUpload] finalized", { sessionId: session.id, gameId: session.gameId });
}

type FolderObjectRef = { key: string; sizeBytes: number; sha256: string; etag?: string;
  kind: "file" | "bundle"; parts: number[] };
type MetadataProgress = { status: string; batch_count: number | null; processed_count: number;
  objects_json: string; total_size_bytes: number; file_count: number; active_bundle_client_id: string | null;
  active_bundle_next: number; active_bundle_count: number; active_bundle_members: number; updated_at: number };

function metadataPartKey(gameId: string, manifestId: string, index: number) {
  return `${gameId}/manifest-parts/${manifestId}/${String(index).padStart(6, "0")}.json`;
}
function metadataManifestKey(gameId: string, manifestId: string) { return `${gameId}/manifests/${manifestId}.json`; }
function folderObjectId(key: string) { return key.slice(key.lastIndexOf("/") + 1).toLowerCase(); }
function normalizedPath(value: unknown) {
  const path = String(value || "").replace(/\\/g, "/");
  const segments = path.split("/");
  if (!path || path.length > 500 || path.startsWith("/") || segments.length > 32 ||
      segments.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) ||
        part.toLowerCase() === ".merlin-install.json")) fail("Caminho de arquivo inválido.");
  return path.normalize("NFC");
}
async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown, maxBytes: number) {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) fail("Índice do pacote acima do limite permitido.");
  const created = await bucket.put(key, serialized, { ...JSON_METADATA, onlyIf: { etagDoesNotMatch: "*" } });
  if (created) return;
  const existing = await bucket.get(key);
  if (!existing || await existing.text() !== serialized) fail("A chave deste pacote já pertence a outro conteúdo.", 409);
}
async function deletePrefix(bucket: R2Bucket, prefix: string) {
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
    // Always read the first page again after deleting it. Opaque continuation
    // cursors can skip keys when the current page is removed mid-cleanup.
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return;
    for (let offset = 0; offset < page.objects.length; offset += 1000) {
      await bucket.delete(page.objects.slice(offset, offset + 1000).map(object => object.key));
    }
  }
  fail("A limpeza encontrou mais metadados do que o limite permitido.", 409);
}
async function readMetadataProgress(db: D1Database, sessionId: string, manifestId: string) {
  return db.prepare(`SELECT status,batch_count,processed_count,objects_json,total_size_bytes,file_count,
      active_bundle_client_id,active_bundle_next,active_bundle_count,active_bundle_members,updated_at
    FROM custom_game_metadata_sessions WHERE session_id=? AND manifest_id=?`)
    .bind(sessionId, manifestId).first<MetadataProgress>();
}
async function ensureMetadataBatchLive(db: D1Database, sessionId: string, manifestId: string, index: number) {
  const state = await db.prepare(`SELECT s.status,b.sha256,
      EXISTS(SELECT 1 FROM custom_game_metadata_cancelled_sessions x WHERE x.session_id=s.session_id) AS cancelled
    FROM custom_game_metadata_sessions s LEFT JOIN custom_game_metadata_batches b
      ON b.session_id=s.session_id AND b.manifest_id=s.manifest_id AND b.batch_index=?
    WHERE s.session_id=? AND s.manifest_id=?`)
    .bind(index, sessionId, manifestId).first<{ status: string; sha256: string | null; cancelled: number }>();
  if (!state || state.cancelled || state.status === "cancelled") fail("O envio foi descartado durante a gravação do lote.", 409);
  return state;
}
async function cleanupMetadataRows(db: D1Database, sessionId: string, manifestId: string, status: "finalized" | "cancelled") {
  const statements = status === "cancelled" ? [db.prepare(`INSERT INTO custom_game_metadata_cancelled_sessions(session_id,cancelled_at)
    VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`).bind(sessionId, Date.now())] : [];
  await db.batch([
    ...statements,
    db.prepare("DELETE FROM custom_game_metadata_files WHERE session_id=? AND manifest_id=?").bind(sessionId, manifestId),
    db.prepare("DELETE FROM custom_game_metadata_batches WHERE session_id=? AND manifest_id=?").bind(sessionId, manifestId),
    db.prepare(`UPDATE custom_game_metadata_sessions SET status=?,objects_json='{}',total_size_bytes=0,file_count=0,
      active_bundle_client_id=NULL,active_bundle_next=0,active_bundle_count=0,active_bundle_members=0,updated_at=?
      WHERE session_id=? AND manifest_id=?`).bind(status, Date.now(), sessionId, manifestId),
  ]);
}
async function loadMetadataBatch(bucket: R2Bucket, session: GameUploadSession, manifestId: string, index: number, expectedSha: string) {
  const key = metadataBatchKey(session.id, manifestId, index);
  const object = await bucket.get(key);
  if (!object || object.size > 256 * 1024) fail("Um lote de metadados está ausente ou acima do limite. Reenvie a mesma pasta.", 409);
  const serialized = await object.text();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== expectedSha) fail("Um lote de metadados foi alterado. Reenvie a mesma pasta.", 409);
  let value: { manifestId?: string; entries?: any[] };
  try { value = JSON.parse(serialized); } catch { fail("Lote de metadados inválido.", 409); }
  if (value.manifestId !== manifestId || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 500) {
    fail("Lote de metadados inválido.", 409);
  }
  return value.entries;
}
async function processMetadataBatch(c: AppContext, session: GameUploadSession, manifestId: string,
  index: number, progress: MetadataProgress, expectedSha: string, suppliedEntries?: any[]) {
  const { env } = c;
  const db = env.merlin_db;
  const entries = suppliedEntries || await loadMetadataBatch(env.CUSTOM_GAMES, session, manifestId, index, expectedSha);
  const checkpointByClient = await checkpointsByClient(c, session,
    entries.map(entry => client(entry?.clientId)));
  const refs = JSON.parse(progress.objects_json || "{}") as Record<string, FolderObjectRef>;
  if (!refs || Array.isArray(refs) || typeof refs !== "object") fail("Índice de objetos inválido.", 409);
  let totalSizeBytes = progress.total_size_bytes;
  let fileCount = progress.file_count;
  let activeClient = progress.active_bundle_client_id || "";
  let activeNext = progress.active_bundle_next;
  let activeCount = progress.active_bundle_count;
  let activeMembers = progress.active_bundle_members;
  const output: any[] = [];
  const objectKeys = new Map<string, { clientId: string; key: string; sizeBytes: number; sha256: string; kind: "file" | "bundle" }>();
  let metadataEntries = 0;
  const getCheckpoint = (clientId: string) => {
    const item = checkpointByClient.get(clientId);
    if (!item || !item.completed || !item.etag || !item.key.startsWith(`${session.gameId}/files/`)) {
      fail("Um objeto do pacote não foi concluído nesta sessão.", 409);
    }
    return item;
  };
  for (const entry of entries) {
    if (!entry || (entry.kind !== "file" && entry.kind !== "bundle")) fail("Objeto de metadados inválido.", 409);
    const clientId = client(entry.clientId);
    const saved = getCheckpoint(clientId);
    const key = String(entry.key || "");
    const sizeBytes = Number(entry.sizeBytes);
    const checksum = sha(entry.sha256);
    if (saved.key !== key || saved.sizeBytes !== sizeBytes || saved.sha256 !== checksum ||
        !/^([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/i.test(key) || !key.startsWith(`${session.gameId}/files/`)) {
      fail("Objeto não pertence ao envio confirmado.", 409);
    }
    const priorObject = objectKeys.get(clientId);
    const object = { clientId, key, sizeBytes, sha256: checksum, kind: entry.kind } as const;
    if (priorObject && (priorObject.key !== key || priorObject.sizeBytes !== sizeBytes || priorObject.sha256 !== checksum || priorObject.kind !== entry.kind)) {
      fail("Os fragmentos do pacote não correspondem ao objeto enviado.", 409);
    }
    objectKeys.set(clientId, object);
    const members = entry.kind === "file" ? [entry] : entry.files;
    if (!Array.isArray(members) || members.length < 1 || members.length > 500) fail("Fragmento de metadados inválido.", 409);
    const id = folderObjectId(key);
    const priorRef = refs[id];
    if (entry.kind === "file" && (activeClient || priorObject || priorRef)) {
      fail("Arquivo repetido ou fragmentos de pacote fora de ordem.", 409);
    }
    if (entry.kind === "bundle" && (sizeBytes < 1 || sizeBytes > MAX_BUNDLE_SIZE ||
        !Number.isSafeInteger(entry.fragmentIndex) || !Number.isSafeInteger(entry.fragmentCount) ||
        entry.fragmentCount < 1 || entry.fragmentCount > 3000 || entry.fragmentIndex < 0 || entry.fragmentIndex >= entry.fragmentCount)) {
      fail("Fragmento de pacote inválido.", 409);
    }
    let ref = priorRef;
    if (!ref) {
      if (entry.kind === "bundle" ? entry.fragmentIndex !== 0 : false) fail("Faltou o primeiro fragmento do pacote.", 409);
      ref = refs[id] = { key, sizeBytes, sha256: checksum, etag: saved.etag, kind: entry.kind, parts: [] };
    } else if (ref.key !== key || ref.sizeBytes !== sizeBytes || ref.sha256 !== checksum || ref.kind !== entry.kind) {
      fail("O manifesto contém objetos duplicados ou inconsistentes.", 409);
    }
    if (!ref.parts.includes(index)) ref.parts.push(index);
    if (entry.kind === "bundle") {
      if (!activeClient) {
        if (entry.fragmentIndex !== 0 || priorRef) fail("Faltou o primeiro fragmento do pacote ou o objeto foi repetido.", 409);
        activeClient = clientId; activeNext = 0; activeCount = entry.fragmentCount; activeMembers = 0;
      }
      if (activeClient !== clientId || entry.fragmentIndex !== activeNext || entry.fragmentCount !== activeCount) {
        fail("Os fragmentos do pacote estão ausentes ou fora de ordem.", 409);
      }
      activeNext++; activeMembers += members.length;
      if (activeMembers > 3000) fail("O pacote contém arquivos demais.", 409);
    }
    const outputMembers: any[] = [];
    for (const member of members) {
      const path = normalizedPath(member.path);
      const memberSize = Number(member.sizeBytes);
      const memberSha = sha(member.sha256);
      const maxMemberSize = entry.kind === "file" ? MAX_OBJECT_SIZE : MAX_BUNDLE_MEMBER_SIZE;
      if (!Number.isSafeInteger(memberSize) || memberSize < 0 || memberSize > maxMemberSize ||
          (memberSize === 0 && memberSha !== EMPTY_SHA256) || (entry.kind === "file" && memberSize !== sizeBytes) ||
          (entry.kind === "file" && memberSha !== checksum)) fail("Tamanho ou hash de arquivo inválido.", 409);
      totalSizeBytes += memberSize; fileCount++; metadataEntries++;
      if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes > MAX_FOLDER_SIZE || fileCount > MAX_FOLDER_GAME_FILES) {
        fail("A pasta ultrapassa o limite de tamanho ou quantidade de arquivos.", 409);
      }
      outputMembers.push({ path, sizeBytes: memberSize, sha256: memberSha });
    }
    if (entry.kind === "file") {
      if (activeClient) fail("Os fragmentos do pacote estão fora de ordem.", 409);
      output.push({ kind: "file", id, path: outputMembers[0]!.path, key, sizeBytes, sha256: checksum, etag: saved.etag });
    } else {
      output.push({ kind: "bundle", id, key, sizeBytes, sha256: checksum, etag: saved.etag,
        fragmentIndex: entry.fragmentIndex, fragmentCount: entry.fragmentCount, files: outputMembers });
      if (activeNext === activeCount) { activeClient = ""; activeNext = 0; activeCount = 0; activeMembers = 0; }
    }
  }
    if (!metadataEntries || Object.keys(refs).length > MAX_METADATA_OBJECTS) fail("O pacote contém objetos demais para indexação segura.", 409);
  // Completed R2 objects are immutable and session-scoped. Check them with a
  // small concurrency limit so finalization never lists or buffers the folder.
  const objectList = [...objectKeys.values()];
  for (let offset = 0; offset < objectList.length; offset += 8) {
    await Promise.all(objectList.slice(offset, offset + 8).map(async item => {
      const saved = checkpointByClient.get(item.clientId)!;
      const remote = await env.CUSTOM_GAMES.head(item.key);
      if (!remote || remote.size !== item.sizeBytes || remote.etag !== saved.etag ||
          remote.customMetadata?.uploadSessionId !== session.id || remote.customMetadata?.clientId !== item.clientId) {
        fail("Um arquivo enviado não corresponde à sessão de upload.", 409);
      }
    }));
  }
  const partKey = metadataPartKey(session.gameId, manifestId, index);
  await putImmutableJson(env.CUSTOM_GAMES, partKey, { entries: output }, 2 * 1024 * 1024);
  const nextObjects = JSON.stringify(refs);
  if (new TextEncoder().encode(nextObjects).byteLength > MAX_METADATA_INDEX_BYTES) fail("O índice de objetos ultrapassa o limite.", 409);
  const at = Date.now();
  const result = await db.batch([
    db.prepare(`UPDATE custom_game_metadata_batches SET processed=1,part_key=?
      WHERE session_id=? AND manifest_id=? AND batch_index=? AND processed=0
        AND EXISTS (SELECT 1 FROM custom_game_metadata_sessions s WHERE s.session_id=? AND s.manifest_id=?
          AND s.status='finalizing' AND s.processed_count=?)`).bind(partKey, session.id, manifestId, index, session.id, manifestId, index),
    db.prepare(`UPDATE custom_game_metadata_sessions SET processed_count=?,objects_json=?,total_size_bytes=?,file_count=?,
        active_bundle_client_id=?,active_bundle_next=?,active_bundle_count=?,active_bundle_members=?,updated_at=?
      WHERE session_id=? AND manifest_id=? AND status='finalizing' AND processed_count=?
        AND EXISTS (SELECT 1 FROM custom_game_metadata_batches b WHERE b.session_id=? AND b.manifest_id=?
          AND b.batch_index=? AND b.processed=1 AND b.part_key=?)`)
      .bind(index + 1, nextObjects, totalSizeBytes, fileCount, activeClient || null, activeNext, activeCount, activeMembers, at,
        session.id, manifestId, index, session.id, manifestId, index, partKey),
  ]);
  if (result[1]?.meta?.changes) {
    if (index === 0 || (index + 1) % 100 === 0 || index + 1 === progress.batch_count) {
      console.log("[CustomGamesUpload] metadata-batch-finalized", { sessionId: session.id, index, batchCount: progress.batch_count,
        fileCount, totalSizeBytes });
    }
    return { processed: index + 1, batchCount: progress.batch_count! };
  }
  const current = await readMetadataProgress(db, session.id, manifestId);
  if (!current || current.status !== "finalizing") {
    if (current?.status === "cancelled") await env.CUSTOM_GAMES.delete(partKey);
    fail("O estado da finalização mudou.", 409);
  }
  return { processed: current.processed_count, batchCount: current.batch_count || 0 };
}

async function removeSessionObjects(bucket: R2Bucket, session: GameUploadSession) {
  let cursor: string | undefined;
  let checkpointCount = 0;
  let deletedObjectCount = 0;
  do {
    const page = await bucket.list({ prefix: `_upload-sessions/${session.id}/objects/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    checkpointCount += page.objects.length;
    for (let offset = 0; offset < page.objects.length; offset += 12) {
      const records = await Promise.all(page.objects.slice(offset, offset + 12).map(async object => ({
        key: object.key, entry: await read<GameUploadCheckpoint>(bucket, object.key),
      })));
      const completedKeys: string[] = [];
      await Promise.all(records.map(async ({ entry }) => {
        const checkpoint = entry?.value;
        if (!checkpoint) return;
        if (checkpoint.uploadId && !checkpoint.completed) {
          await bucket.resumeMultipartUpload(checkpoint.key, checkpoint.uploadId).abort().catch(() => {});
        }
        if (!checkpoint.completed) return;
        const uploaded = await bucket.head(checkpoint.key);
        if (uploaded?.customMetadata?.uploadSessionId === session.id &&
            uploaded.customMetadata.clientId === checkpoint.clientId) completedKeys.push(checkpoint.key);
      }));
      for (let index = 0; index < completedKeys.length; index += 1000) {
        const batch = completedKeys.slice(index, index + 1000);
        await bucket.delete(batch);
        deletedObjectCount += batch.length;
      }
      await bucket.delete(records.map(record => record.key));
    }
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) fail("Não foi possível limpar os checkpoints do upload.", 409);
    cursor = page.cursor;
  } while (cursor);
  return { checkpointCount, deletedObjectCount };
}

async function removeSessionMetadata(bucket: R2Bucket, db: D1Database | undefined, session: GameUploadSession,
  status: "finalized" | "cancelled") {
  if (!db) {
    if (status === "cancelled") await deletePrefix(bucket, `${session.gameId}/manifest-parts/${session.manifestId || "00000000-0000-0000-0000-000000000000"}/`);
    await deletePrefix(bucket, `_upload-sessions/${session.id}/metadata/`);
    return;
  }
  const row = await db.prepare("SELECT manifest_id FROM custom_game_metadata_sessions WHERE session_id=? LIMIT 1")
    .bind(session.id).first<{ manifest_id: string }>();
  const manifestId = row?.manifest_id || session.manifestId;
  if (status === "cancelled" && manifestId) {
    await deletePrefix(bucket, `${session.gameId}/manifest-parts/${manifestId}/`);
  }
  if (manifestId) await cleanupMetadataRows(db, session.id, manifestId, status);
  await deletePrefix(bucket, `_upload-sessions/${session.id}/metadata/`);
}

/** Run periodically from the existing scheduled handler. Never touches finalized packages. */
export async function cleanupExpiredGameUploads(bucket: R2Bucket, now = Date.now(), limit = 10, db?: D1Database) {
  const page = await bucket.list({ prefix: "_upload-session-expiry/", limit: Math.min(100, limit) });
  let cleaned = 0;
  for (const marker of page.objects) {
    const match = /^_upload-session-expiry\/(\d{13})-([0-9a-f-]{36})\.json$/.exec(marker.key);
    if (!match || Number(match[1]) > now) break;
    const id = match[2]!;
    const stored = await read<GameUploadSession>(bucket, sessionKey(id));
    if (!stored) { await bucket.delete(marker.key); continue; }
    // Finalization can be retried safely and has already taken ownership of all
    // completed objects. Expiration must never delete those game files.
    if (stored.value.status === "finalizing") {
      // A failed response/checkpoint can require manual finalization recovery.
      // Preserve every package object but remove its expiry queue entry so it
      // cannot permanently block cleanup of newer abandoned sessions.
      await bucket.delete(marker.key);
      console.warn("[CustomGamesUpload] finalization-recovery-required", { sessionId: id, gameId: stored.value.gameId,
        manifestId: stored.value.manifestId });
      continue;
    }
    if (stored.value.status !== "finalized") {
      if (stored.value.status !== "cancelled") {
        await replace(bucket, sessionKey(id), { ...stored.value, status: "cancelled" }, stored.etag);
      }
      await removeSessionObjects(bucket, stored.value);
      await removeSessionMetadata(bucket, db, stored.value, "cancelled");
    }
    // Keep the small finalized session and checkpoints for recovery/audit; only
    // remove the expiry marker so future scans progress beyond this session.
    await bucket.delete(marker.key);
    cleaned++;
  }
  if (cleaned) console.log("[CustomGamesUpload] expired-cleanup", { cleaned });
  return { cleaned };
}

export function registerGameUploadSessionRoutes(app: Hono<{ Bindings: AppBindings }>) {
  const prefix = "/panel-api/custom-games/upload/sessions";
  app.post(prefix, async c => {
    const adminId = await authenticate(c);
    const body = await c.req.json<{ sessionId?: string; gameId?: string; fingerprint?: string; planVersion?: number }>();
    const gameId = uuid(body.gameId);
    const fingerprint = sha(body.fingerprint);
    if (body.planVersion !== 2) fail("Versão do plano de upload inválida.");
    if (body.sessionId) {
      const existing = await getSession(c, body.sessionId, adminId);
      if (existing.value.gameId !== gameId || existing.value.fingerprint !== fingerprint) fail("A pasta não corresponde ao upload anterior.", 409);
      return c.json(responseSession(c, existing.value, await checkpoints(c.env.CUSTOM_GAMES, existing.value.id)));
    }
    const session: GameUploadSession = { version: 1, id: crypto.randomUUID(), gameId, adminId, fingerprint,
      planVersion: 2, status: "open", createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
    await c.env.CUSTOM_GAMES.put(sessionKey(session.id), JSON.stringify(session), JSON_METADATA);
    await c.env.CUSTOM_GAMES.put(expiryKey(session), "", JSON_METADATA);
    console.log("[CustomGamesUpload] created", { sessionId: session.id, gameId, transport: directConfig(c.env) ? "direct" : "proxy" });
    return c.json(responseSession(c, session, []), 201);
  });
  app.get(`${prefix}/:sessionId`, async c => {
    const adminId = await authenticate(c, false);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    return c.json(responseSession(c, session, await checkpoints(c.env.CUSTOM_GAMES, session.id)));
  });
  // Metadata is bounded independently of the game binaries. Existing object
  // checkpoints remain authoritative for ownership, size and SHA-256.
  app.post(`${prefix}/:sessionId/metadata/batches/:index`, async c => {
    const adminId = await authenticate(c);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    const indexText = c.req.param("index");
    if (!/^(0|[1-9]\d{0,5})$/.test(indexText)) fail("Índice de lote inválido.");
    const bytes = await limitedRequestBytes(c, 256 * 1024);
    let body: { manifestId?: string; entries?: any[] };
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { fail("Lote de metadados inválido."); }
    const manifestId = uuid(body.manifestId);
    if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 500) fail("Lote de metadados inválido.");
    const serialized = JSON.stringify(body);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const db = c.env.merlin_db;
    const existingBatch = await db.prepare(`SELECT sha256 FROM custom_game_metadata_batches
      WHERE session_id=? AND manifest_id=? AND batch_index=?`).bind(session.id, manifestId, Number(indexText)).first<{sha256:string}>();
    if (existingBatch) {
      if (existingBatch.sha256 !== digest) fail("O lote já existe com conteúdo diferente.", 409);
      const live = await ensureMetadataBatchLive(db, session.id, manifestId, Number(indexText));
      if (live.sha256 !== digest) fail("O lote já existe com conteúdo diferente.", 409);
      if (live.status === "finalized") return c.json({ success: true, index: Number(indexText) });
      const batchKey = metadataBatchKey(session.id, manifestId, Number(indexText));
      const object = await c.env.CUSTOM_GAMES.get(batchKey);
      if (object && await object.text() !== serialized) fail("O lote armazenado não corresponde ao envio.", 409);
      if (!object) {
        const restored = await c.env.CUSTOM_GAMES.put(batchKey, serialized, { ...JSON_METADATA, onlyIf: { etagDoesNotMatch: "*" } });
        if (!restored) {
          const concurrent = await c.env.CUSTOM_GAMES.get(batchKey);
          if (!concurrent || await concurrent.text() !== serialized) fail("O lote armazenado mudou durante a recuperação.", 409);
        }
      }
      let afterWrite: Awaited<ReturnType<typeof ensureMetadataBatchLive>>;
      try { afterWrite = await ensureMetadataBatchLive(db, session.id, manifestId, Number(indexText)); }
      catch (error) { await c.env.CUSTOM_GAMES.delete(batchKey); throw error; }
      if (afterWrite.sha256 !== digest) fail("O lote foi alterado durante a recuperação.", 409);
      return c.json({ success: true, index: Number(indexText) });
    }
    requireOpen(session);
    const cancelled = await db.prepare("SELECT 1 AS found FROM custom_game_metadata_cancelled_sessions WHERE session_id=?")
      .bind(session.id).first();
    if (cancelled) fail("O envio foi descartado e não aceita novos lotes.", 409);
    const clientIds = body.entries.map(entry => {
      if (!entry || (entry.kind !== "file" && entry.kind !== "bundle")) fail("Objeto de metadados inválido.");
      return client(entry.clientId);
    });
    const byClient = await checkpointsByClient(c, session, clientIds);
    let count = 0;
    const paths: string[] = [];
    for (let entryIndex = 0; entryIndex < body.entries.length; entryIndex++) {
      const entry = body.entries[entryIndex]!;
      const clientId = client(entry.clientId);
      const saved = byClient.get(clientId);
      if (!saved?.completed || saved.sizeBytes !== entry.sizeBytes || saved.sha256 !== sha(entry.sha256) ||
          saved.key !== entry.key || !entry.key.startsWith(`${session.gameId}/files/`)) fail("Objeto não pertence ao envio ou está incompleto.", 409);
      const members = entry.kind === "file" ? [entry] : entry.files;
      if (!Array.isArray(members) || !members.length || members.length > 500 ||
          (entry.kind === "bundle" && (!Number.isSafeInteger(entry.fragmentIndex) ||
          !Number.isSafeInteger(entry.fragmentCount) || entry.fragmentIndex < 0 ||
          entry.fragmentCount < 1 || entry.fragmentIndex >= entry.fragmentCount))) fail("Fragmento inválido.");
      count += members.length;
      if (count > 500) fail("Lote contém entradas demais.");
      for (const member of members) {
        const path = normalizedPath(member.path);
        const segments = path.split("/");
        if (!path || path.length > 500 || path.startsWith("/") || segments.length > 32 ||
            segments.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) ||
              /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part) ||
              part.toLowerCase() === ".merlin-install.json")) fail("Caminho de arquivo inválido.");
        if (!Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 0 || member.sizeBytes > MAX_OBJECT_SIZE ||
            (member.sizeBytes === 0 && sha(member.sha256) !== EMPTY_SHA256)) fail("Tamanho ou hash inválido.");
        sha(member.sha256);
        const normalized = path.toLocaleLowerCase("en-US");
        paths.push(normalized);
      }
    }
    try {
      await db.batch([
        db.prepare(`INSERT INTO custom_game_metadata_sessions(session_id,manifest_id) VALUES(?,?)
          ON CONFLICT(session_id,manifest_id) DO NOTHING`).bind(session.id, manifestId),
        db.prepare(`INSERT INTO custom_game_metadata_batches(session_id,manifest_id,batch_index,sha256) VALUES(?,?,?,?)`)
          .bind(session.id, manifestId, Number(indexText), digest),
        db.prepare(`INSERT INTO custom_game_metadata_files(session_id,manifest_id,path)
          SELECT ?,?,value FROM json_each(?)`).bind(session.id, manifestId, JSON.stringify(paths)),
      ]);
    } catch (error) {
      const replay = await db.prepare(`SELECT sha256 FROM custom_game_metadata_batches
        WHERE session_id=? AND manifest_id=? AND batch_index=?`).bind(session.id, manifestId, Number(indexText)).first<{sha256:string}>();
      if (!replay || replay.sha256 !== digest) {
        console.warn("[CustomGamesUpload] metadata-batch-rejected", { sessionId: session.id, index: Number(indexText),
          reason: error instanceof Error ? error.message.slice(0, 150) : "unknown" });
        fail("O lote contém caminhos duplicados, conflitos ou o envio foi encerrado.", 409);
      }
    }
    // Commit the small collision index first. If the process stops before this
    // immutable R2 write, an identical retry repairs it without orphaning data
    // after a concurrent cancellation.
    const key = metadataBatchKey(session.id, manifestId, Number(indexText));
    const created = await c.env.CUSTOM_GAMES.put(key, serialized, { ...JSON_METADATA, onlyIf: { etagDoesNotMatch: "*" } });
    if (!created) {
      const existing = await c.env.CUSTOM_GAMES.get(key);
      if (!existing || await existing.text() !== serialized) fail("O lote já existe com conteúdo diferente.", 409);
    }
    let afterWrite: Awaited<ReturnType<typeof ensureMetadataBatchLive>>;
    try { afterWrite = await ensureMetadataBatchLive(db, session.id, manifestId, Number(indexText)); }
    catch (error) { await c.env.CUSTOM_GAMES.delete(key); throw error; }
    if (afterWrite.sha256 !== digest) {
      await c.env.CUSTOM_GAMES.delete(key);
      fail("O lote foi alterado durante a gravação.", 409);
    }
    return c.json({ success: true, index: Number(indexText) });
  });
  app.post(`${prefix}/:sessionId/metadata/complete`, async c => {
    const adminId = await authenticate(c);
    const storedSession = await getSession(c, c.req.param("sessionId"), adminId);
    let session = storedSession.value;
    const body = await c.req.json<{ manifestId?: string; batchCount?: number }>();
    const manifestId = uuid(body.manifestId);
    const batchCount = Number(body.batchCount);
    if (!Number.isSafeInteger(batchCount) || batchCount < 1 || batchCount > 100_000) fail("Quantidade de lotes inválida.");
    if (session.manifestId && session.manifestId !== manifestId) fail("O manifesto não corresponde à sessão de upload.", 409);
    const manifestKey = metadataManifestKey(session.gameId, manifestId);
    if (session.status === "finalized") {
      if (session.manifestKey !== manifestKey) fail("O pacote já foi finalizado com outro manifesto.", 409);
      const indexObject = await c.env.CUSTOM_GAMES.head(manifestKey);
      if (!indexObject) fail("O manifesto finalizado não está disponível.", 409);
      const index = await c.env.CUSTOM_GAMES.get(manifestKey);
      const value = await index!.json<{ totalSizeBytes?: number; objects?: Record<string, unknown> }>();
      await removeSessionMetadata(c.env.CUSTOM_GAMES, c.env.merlin_db, session, "finalized");
      return c.json({ success: true, status: "complete", key: manifestKey,
        sizeBytes: Number(value.totalSizeBytes), fileCount: undefined,
        objectCount: Object.keys(value.objects || {}).length, packageType: "folder" });
    }
    if (session.status === "cancelled") fail("A sessão de upload foi cancelada.", 409);

    const db = c.env.merlin_db;
    let progress = await readMetadataProgress(db, session.id, manifestId);
    if (!progress) fail("Os lotes de metadados ainda não foram enviados.", 409);
    if (progress.status === "open") {
      const stats = await db.prepare(`SELECT COUNT(*) AS count,MIN(batch_index) AS first,MAX(batch_index) AS last
        FROM custom_game_metadata_batches WHERE session_id=? AND manifest_id=?`)
        .bind(session.id, manifestId).first<{ count: number; first: number | null; last: number | null }>();
      if (!stats || stats.count !== batchCount || stats.first !== 0 || stats.last !== batchCount - 1) {
        fail("Faltam lotes de metadados. Reenvie o mesmo envio para continuar.", 409);
      }
      await db.prepare(`UPDATE custom_game_metadata_sessions SET status='finalizing',batch_count=?,updated_at=?
        WHERE session_id=? AND manifest_id=? AND status='open'`).bind(batchCount, Date.now(), session.id, manifestId).run();
      progress = await readMetadataProgress(db, session.id, manifestId);
    }
    if (!progress || progress.batch_count !== batchCount || !["finalizing", "publishing", "finalized"].includes(progress.status)) {
      fail("O estado dos lotes mudou durante a finalização.", 409);
    }
    if (progress.status === "finalized") {
      const currentSession = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(session.id));
      if (currentSession?.value.status !== "finalized" || currentSession.value.manifestKey !== manifestKey) {
        fail("A sessão foi finalizada sem confirmar o manifesto.", 409);
      }
      const index = await c.env.CUSTOM_GAMES.get(manifestKey);
      if (!index) fail("O manifesto finalizado não está disponível.", 409);
      const value = await index.json<{ totalSizeBytes: number; objects?: Record<string, unknown> }>();
      return c.json({ success: true, status: "complete", key: manifestKey, sizeBytes: value.totalSizeBytes,
        objectCount: Object.keys(value.objects || {}).length, packageType: "folder" });
    }
    // Refresh the stale-finalization guard before doing bounded R2 reads. The
    // database cursor is authoritative for cancellation races.
    const heartbeat = await db.prepare(`UPDATE custom_game_metadata_sessions SET updated_at=?
      WHERE session_id=? AND manifest_id=? AND status IN ('finalizing','publishing') AND processed_count=?`)
      .bind(Date.now(), session.id, manifestId, progress.processed_count).run();
    if (!heartbeat.meta?.changes) {
      const latest = await readMetadataProgress(db, session.id, manifestId);
      if (!latest || latest.status === "cancelled" || latest.status === "open") {
        fail("A sessão foi cancelada ou mudou antes de continuar a finalização.", 409);
      }
      progress = latest;
    }
    if (session.status === "open") {
      const nextSession: GameUploadSession = { ...session, status: "finalizing", finalizingAt: Date.now(), manifestId };
      try {
        await replace(c.env.CUSTOM_GAMES, sessionKey(session.id), nextSession, storedSession.etag);
        session = nextSession;
      } catch {
        const current = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(session.id));
        if (!current || current.value.status !== "finalizing" || current.value.manifestId !== manifestId) {
          fail("A sessão mudou durante o início da finalização.", 409);
        }
        session = current.value;
      }
    }
    if (progress.status === "finalizing" && progress.processed_count < batchCount) {
      let batchesProcessed = 0;
      let checkedObjects = 0;
      while (progress.status === "finalizing" && progress.processed_count < batchCount &&
          batchesProcessed < MAX_FINALIZATION_BATCHES_PER_REQUEST) {
        const index = progress.processed_count;
        const batch = await db.prepare(`SELECT sha256 FROM custom_game_metadata_batches
          WHERE session_id=? AND manifest_id=? AND batch_index=?`).bind(session.id, manifestId, index).first<{ sha256: string }>();
        if (!batch) fail("Falta um lote de metadados. Reenvie o mesmo envio para continuar.", 409);
        const entries = await loadMetadataBatch(c.env.CUSTOM_GAMES, session, manifestId, index, batch.sha256);
        const objectCount = new Set(entries.map(entry => client(entry?.clientId))).size;
        if (batchesProcessed && checkedObjects + objectCount > MAX_FINALIZATION_OBJECTS_PER_REQUEST) break;
        await processMetadataBatch(c, session, manifestId, index, progress, batch.sha256, entries);
        checkedObjects += objectCount;
        batchesProcessed++;
        const latest = await readMetadataProgress(db, session.id, manifestId);
        if (!latest) fail("O estado da finalização não está disponível.", 409);
        progress = latest;
      }
      if (progress.status === "finalizing" && progress.processed_count < batchCount) {
        return c.json({ success: true, status: "processing", processedBatches: progress.processed_count, batchCount });
      }
    }
    if (progress.file_count < 1 || progress.file_count > MAX_FOLDER_GAME_FILES || progress.total_size_bytes < 1 ||
        progress.total_size_bytes > MAX_FOLDER_SIZE || progress.active_bundle_client_id || progress.active_bundle_next ||
        progress.active_bundle_count || progress.active_bundle_members) fail("Os lotes não formam um manifesto completo.", 409);
    let objects: Record<string, FolderObjectRef>;
    try { objects = JSON.parse(progress.objects_json || "{}"); } catch { fail("Índice de objetos inválido.", 409); }
    if (progress.status === "finalizing") {
      const claimed = await db.prepare(`UPDATE custom_game_metadata_sessions SET status='publishing',updated_at=?
        WHERE session_id=? AND manifest_id=? AND status='finalizing' AND processed_count=?`)
        .bind(Date.now(), session.id, manifestId, batchCount).run();
      if (!claimed.meta?.changes) {
        const current = await readMetadataProgress(db, session.id, manifestId);
        if (current?.status !== "publishing") fail("A finalização mudou antes da publicação do manifesto.", 409);
      }
    } else if (progress.status !== "publishing") fail("Estado de publicação inválido.", 409);
    const partKeys = Array.from({ length: batchCount }, (_, index) => metadataPartKey(session.gameId, manifestId, index));
    const manifest = { version: 4, totalSizeBytes: progress.total_size_bytes,
      parts: partKeys.map(key => ({ key })), objects };
    await putImmutableJson(c.env.CUSTOM_GAMES, manifestKey, manifest, MAX_METADATA_INDEX_BYTES);
    await finishGameUploadFinalization(c, session, manifestKey);
    await removeSessionMetadata(c.env.CUSTOM_GAMES, db, session, "finalized");
    return c.json({ success: true, status: "complete", key: manifestKey, sizeBytes: progress.total_size_bytes,
      fileCount: progress.file_count, objectCount: Object.keys(objects).length, packageType: "folder" }, 201);
  });
  app.post(`${prefix}/:sessionId/objects/initiate`, async c => {
    const adminId = await authenticate(c);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    requireOpen(session);
    const body = await c.req.json<{ clientId?: string; filename?: string; sizeBytes?: number; sha256?: string }>();
    const clientId = client(body.clientId);
    const sizeBytes = Number(body.sizeBytes);
    const filename = String(body.filename || "").slice(0, 500);
    if (!filename || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_OBJECT_SIZE) fail("Arquivo de upload inválido.");
    const suppliedSha = body.sha256 === undefined ? undefined : sha(body.sha256);
    if (sizeBytes === 0 && suppliedSha !== EMPTY_SHA256) fail("Hash do arquivo vazio inválido.");
    const existing = await read<GameUploadCheckpoint>(c.env.CUSTOM_GAMES, checkpointKey(session.id, clientId));
    if (existing) {
      if (existing.value.sizeBytes !== sizeBytes || existing.value.filename !== filename ||
          (suppliedSha && existing.value.sha256 && suppliedSha !== existing.value.sha256)) fail("O objeto não corresponde ao envio anterior.", 409);
      if (existing.value.state !== "initiating") return c.json({ success: true, ...existing.value, partSize: PART_SIZE });
      if (Date.now() - existing.value.createdAt < 120_000) fail("Este arquivo está sendo preparado. Tente novamente.", 409);
      // A terminated Worker may leave the reservation before the multipart ID
      // is recorded. Recover a stale reservation; R2's incomplete-multipart
      // lifecycle covers a server interruption between create and checkpoint.
      await c.env.CUSTOM_GAMES.delete(checkpointKey(session.id, clientId));
    }
    const entry: GameUploadCheckpoint = { clientId, key: `${session.gameId}/files/${crypto.randomUUID()}`,
      filename, sizeBytes, sha256: suppliedSha, completed: false, state: "initiating", createdAt: Date.now() };
    const locked = await c.env.CUSTOM_GAMES.put(checkpointKey(session.id, clientId), JSON.stringify(entry), {
      ...JSON_METADATA, onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!locked) fail("Este arquivo já está sendo preparado. Tente novamente.", 409);
    let uploadId: string | undefined;
    try {
      if (sizeBytes === 0) {
        const object = await c.env.CUSTOM_GAMES.put(entry.key, new Uint8Array(0), { customMetadata: { uploadSessionId: session.id, clientId },
          httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
        entry.completed = true; entry.state = "completed"; entry.etag = object!.etag;
      } else {
        const upload = await c.env.CUSTOM_GAMES.createMultipartUpload(entry.key, { customMetadata: { uploadSessionId: session.id, clientId },
          httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
        uploadId = upload.uploadId; entry.uploadId = uploadId; entry.state = "uploading";
      }
      const currentSession = await getSession(c, session.id, adminId);
      requireOpen(currentSession.value);
      await replace(c.env.CUSTOM_GAMES, checkpointKey(session.id, clientId), entry, locked.etag);
    } catch (error) {
      if (uploadId) await c.env.CUSTOM_GAMES.resumeMultipartUpload(entry.key, uploadId).abort().catch(() => {});
      await c.env.CUSTOM_GAMES.delete(entry.key);
      await c.env.CUSTOM_GAMES.delete(checkpointKey(session.id, clientId));
      throw error;
    }
    return c.json({ success: true, ...entry, partSize: PART_SIZE }, 201);
  });
  app.post(`${prefix}/:sessionId/objects/sign`, async c => {
    const adminId = await authenticate(c);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    requireOpen(session);
    const body = await c.req.json<{ clientId?: string; partNumbers?: number[] }>();
    const { value: entry } = await checkpoint(c, session, client(body.clientId));
    if (entry.completed || !entry.uploadId) fail("Este arquivo já foi concluído.", 409);
    const config = directConfig(c.env);
    if (!config) fail("Upload direto indisponível. Continue pelo envio padrão.", 503);
    const partNumbers = body.partNumbers;
    if (!Array.isArray(partNumbers) || partNumbers.length < 1 || partNumbers.length > 16 || new Set(partNumbers).size !== partNumbers.length ||
        partNumbers.some(number => !Number.isInteger(number) || number < 1 || number > Math.ceil(entry.sizeBytes / PART_SIZE))) fail("Partes inválidas.");
    const signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto" });
    const parts = await Promise.all(partNumbers.map(async partNumber => {
      const url = new URL(`${config.origin}/${config.bucket}/${entry.key.split("/").map(encodeURIComponent).join("/")}`);
      url.searchParams.set("partNumber", String(partNumber)); url.searchParams.set("uploadId", entry.uploadId!);
      url.searchParams.set("X-Amz-Expires", "900");
      const signed = await signer.sign(url, { method: "PUT", aws: { signQuery: true } });
      return { partNumber, url: signed.url };
    }));
    return c.json({ success: true, expiresIn: 900, parts });
  });
  app.post(`${prefix}/:sessionId/objects/part`, async c => {
    const adminId = await authenticate(c);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    requireOpen(session);
    const { value: entry } = await checkpoint(c, session, client(c.req.query("clientId")));
    const partNumber = Number(c.req.query("partNumber"));
    const contentLength = Number(c.req.header("content-length"));
    const count = Math.ceil(entry.sizeBytes / PART_SIZE);
    const expectedSize = partNumber === count ? entry.sizeBytes - (count - 1) * PART_SIZE : PART_SIZE;
    if (entry.completed || !entry.uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > count ||
        contentLength !== expectedSize || !c.req.raw.body) fail("Parte de upload inválida.");
    const started = Date.now();
    const part = await c.env.CUSTOM_GAMES.resumeMultipartUpload(entry.key, entry.uploadId).uploadPart(partNumber, c.req.raw.body);
    console.log("[CustomGamesUpload] part", { sessionId: session.id, clientId: entry.clientId, partNumber, sizeBytes: contentLength, elapsedMs: Date.now() - started });
    return c.json({ success: true, partNumber: part.partNumber, etag: part.etag });
  });
  app.post(`${prefix}/:sessionId/objects/complete`, async c => {
    const adminId = await authenticate(c);
    const { value: session } = await getSession(c, c.req.param("sessionId"), adminId);
    requireOpen(session);
    const body = await c.req.json<{ clientId?: string; parts?: unknown; sizeBytes?: number; sha256?: string }>();
    const stored = await checkpoint(c, session, client(body.clientId));
    const entry = stored.value;
    const checksum = sha(body.sha256);
    if (Number(body.sizeBytes) !== entry.sizeBytes || (entry.sha256 && entry.sha256 !== checksum)) fail("Os dados do arquivo não correspondem ao upload.", 409);
    if (entry.completed) return c.json({ success: true, ...entry });
    if (!entry.uploadId) fail("Arquivo ainda não preparado.", 409);
    const parts = validateParts(body.parts, entry.sizeBytes);
    const started = Date.now();
    let object;
    try {
      object = await completeGameMultipart(c.env.CUSTOM_GAMES, entry.key, entry.uploadId, parts, entry.sizeBytes);
    } catch (error) {
      if (!isMissingMultipartPartError(error)) throw error;
      const current = await checkpoint(c, session, entry.clientId);
      if (current.value.completed && current.value.sha256 === checksum) return c.json({ success: true, ...current.value });
      const replacement = current.value.uploadId === entry.uploadId
        ? await restartGameMultipart(c.env.CUSTOM_GAMES, session, entry, current)
        : current.value;
      console.warn("[CustomGamesUpload] multipart-parts-reset", {
        sessionId: session.id, clientId: entry.clientId, partCount: parts.length,
      });
      return c.json({ success: false, code: "multipart_parts_reset",
        error: "Uma parte deste arquivo não foi reconhecida pelo R2. Reenviando somente este arquivo.",
        uploadId: replacement.uploadId }, 409);
    }
    const completed: GameUploadCheckpoint = { ...entry, sha256: checksum, completed: true, state: "completed", etag: object.etag };
    try { await replace(c.env.CUSTOM_GAMES, checkpointKey(session.id, entry.clientId), completed, stored.etag); }
    catch (error) {
      const current = await checkpoint(c, session, entry.clientId);
      if (!current.value.completed || current.value.sha256 !== checksum || current.value.sizeBytes !== entry.sizeBytes) throw error;
      return c.json({ success: true, ...current.value });
    }
    console.log("[CustomGamesUpload] object-completed", { sessionId: session.id, clientId: entry.clientId, sizeBytes: entry.sizeBytes, elapsedMs: Date.now() - started });
    return c.json({ success: true, ...completed });
  });
  app.post(`${prefix}/:sessionId/cancel`, async c => {
    const adminId = await authenticate(c);
    const stored = await getSession(c, c.req.param("sessionId"), adminId, true);
    if (stored.value.status === "finalized") fail("Este pacote já foi finalizado e não pode ser cancelado.", 409);
    const metadataState = await c.env.merlin_db.prepare(`SELECT manifest_id,status,updated_at FROM custom_game_metadata_sessions
      WHERE session_id=? LIMIT 1`).bind(stored.value.id)
      .first<{ manifest_id: string; status: string; updated_at: number }>();
    if (metadataState?.status === "finalized") fail("Este pacote já foi finalizado e não pode ser cancelado.", 409);
    if (metadataState?.status === "publishing") fail("O manifesto já está sendo publicado. Aguarde a finalização antes de descartar.", 409);
    if (stored.value.status === "finalizing" || metadataState?.status === "finalizing") {
      const lastProgressAt = metadataState?.updated_at ?? stored.value.finalizingAt;
      if (!lastProgressAt || Date.now() - lastProgressAt < 10 * 60_000) {
        fail("Este pacote ainda está sendo finalizado. Aguarde alguns minutos antes de descartá-lo.", 409);
      }
      const manifestId = metadataState?.manifest_id || stored.value.manifestId;
      const manifestKey = manifestId ? metadataManifestKey(stored.value.gameId, manifestId) : "";
      if (!manifestKey || stored.value.manifestKey || await c.env.CUSTOM_GAMES.head(manifestKey)) {
        fail("O manifesto já foi criado e precisa ser finalizado antes do descarte.", 409);
      }
      const currentReference = await c.env.merlin_db.prepare(
        "SELECT id FROM custom_games WHERE archive_key=? UNION ALL SELECT game_id AS id FROM custom_game_versions WHERE archive_key=? AND status!='deleted' LIMIT 1")
        .bind(manifestKey, manifestKey).first();
      if (currentReference) fail("Este pacote já está vinculado a um jogo e não pode ser descartado.", 409);
    }
    // Claim cancellation in the same D1 transaction as the durable tombstone.
    // Batch insertion and finalization both use this row as their fence, so a
    // late R2 write cannot recreate metadata after the cleanup pass.
    const cancelAt = Date.now();
    const staleBefore = cancelAt - 10 * 60_000;
    await c.env.merlin_db.batch([
      c.env.merlin_db.prepare(`UPDATE custom_game_metadata_sessions SET status='cancelled',updated_at=?
        WHERE session_id=? AND (status='open' OR status='cancelled' OR (status='finalizing' AND updated_at<=?))`)
        .bind(cancelAt, stored.value.id, staleBefore),
      c.env.merlin_db.prepare(`INSERT INTO custom_game_metadata_cancelled_sessions(session_id,cancelled_at)
        SELECT ?,? WHERE EXISTS(SELECT 1 FROM custom_game_metadata_sessions WHERE session_id=? AND status='cancelled')
          OR NOT EXISTS(SELECT 1 FROM custom_game_metadata_sessions WHERE session_id=?)
        ON CONFLICT(session_id) DO NOTHING`).bind(stored.value.id, cancelAt, stored.value.id, stored.value.id),
      c.env.merlin_db.prepare(`DELETE FROM custom_game_metadata_files WHERE session_id=? AND EXISTS(
        SELECT 1 FROM custom_game_metadata_sessions WHERE session_id=? AND status='cancelled')`)
        .bind(stored.value.id, stored.value.id),
      c.env.merlin_db.prepare(`DELETE FROM custom_game_metadata_batches WHERE session_id=? AND EXISTS(
        SELECT 1 FROM custom_game_metadata_sessions WHERE session_id=? AND status='cancelled')`)
        .bind(stored.value.id, stored.value.id),
    ]);
    const claimedMetadata = await c.env.merlin_db.prepare(`SELECT manifest_id,status FROM custom_game_metadata_sessions
      WHERE session_id=? LIMIT 1`).bind(stored.value.id).first<{ manifest_id: string; status: string }>();
    const cancellationFence = await c.env.merlin_db.prepare(`SELECT 1 AS found FROM custom_game_metadata_cancelled_sessions
      WHERE session_id=?`).bind(stored.value.id).first();
    if (claimedMetadata && claimedMetadata.status !== "cancelled") {
      fail("A finalização avançou durante o descarte. Tente novamente após ela terminar.", 409);
    }
    if (!claimedMetadata && !cancellationFence) fail("A sessão mudou durante o descarte. Tente novamente.", 409);
    let current = stored;
    for (let attempt = 0; current.value.status !== "cancelled" && attempt < 3; attempt++) {
      if (current.value.status === "finalized") fail("Este pacote já foi finalizado e não pode ser cancelado.", 409);
      try {
        await replace(c.env.CUSTOM_GAMES, sessionKey(stored.value.id), { ...current.value, status: "cancelled" }, current.etag);
        current = { value: { ...current.value, status: "cancelled" }, etag: current.etag };
      } catch {
        const latest = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(stored.value.id));
        if (!latest) fail("Sessão de upload não encontrada.", 404);
        current = latest;
      }
    }
    if (current.value.status !== "cancelled") fail("A sessão mudou durante o descarte. Tente novamente.", 409);
    const removed = await removeSessionObjects(c.env.CUSTOM_GAMES, stored.value);
    await removeSessionMetadata(c.env.CUSTOM_GAMES, c.env.merlin_db, stored.value, "cancelled");
    console.log("[CustomGamesUpload] cancelled", { sessionId: stored.value.id, gameId: stored.value.gameId,
      checkpoints: removed.checkpointCount, objects: removed.deletedObjectCount });
    return c.json({ success: true, status: "cancelled" });
  });
}
