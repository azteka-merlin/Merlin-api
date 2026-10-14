import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AwsClient } from "aws4fetch";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";

const PART_SIZE = 64 * 1024 ** 2;
const MAX_OBJECT_SIZE = 30 * 1024 ** 3;
const SESSION_TTL_MS = 7 * 86400_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9_:-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JSON_METADATA = { httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" } };

type SessionState = "open" | "finalizing" | "finalized" | "cancelled";
export type GameUploadSession = {
  version: 1; id: string; adminId: number; gameId: string; fingerprint: string; planVersion: 2;
  status: SessionState; createdAt: number; expiresAt: number; manifestId?: string; manifestKey?: string;
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
async function checkpoint(c: AppContext, session: GameUploadSession, clientId: string) {
  const stored = await read<GameUploadCheckpoint>(c.env.CUSTOM_GAMES, checkpointKey(session.id, client(clientId)));
  if (!stored) fail("Objeto desta sessão não encontrado.", 404);
  return stored;
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
    session.status = "finalizing"; session.manifestId = manifestId;
    await replace(c.env.CUSTOM_GAMES, sessionKey(sessionId), session, stored.etag);
  }
  return session;
}
export async function finishGameUploadFinalization(c: AppContext, session: GameUploadSession, manifestKey: string) {
  const current = await read<GameUploadSession>(c.env.CUSTOM_GAMES, sessionKey(session.id));
  if (!current || !["finalizing", "finalized"].includes(current.value.status)) fail("Estado da sessão inválido.", 409);
  if (current.value.status === "finalized") {
    if (current.value.manifestKey !== manifestKey) fail("Pacote já finalizado.", 409);
    return;
  }
  await replace(c.env.CUSTOM_GAMES, sessionKey(session.id), { ...current.value, status: "finalized", manifestKey }, current.etag);
  console.log("[CustomGamesUpload] finalized", { sessionId: session.id, gameId: session.gameId });
}

async function removeSessionObjects(bucket: R2Bucket, session: GameUploadSession) {
  const entries = await checkpoints(bucket, session.id);
  for (let offset = 0; offset < entries.length; offset += 6) {
    await Promise.all(entries.slice(offset, offset + 6).map(async entry => {
      if (entry.uploadId && !entry.completed) await bucket.resumeMultipartUpload(entry.key, entry.uploadId).abort().catch(() => {});
      await bucket.delete(entry.key);
    }));
  }
  return entries;
}

/** Run periodically from the existing scheduled handler. Never touches finalized packages. */
export async function cleanupExpiredGameUploads(bucket: R2Bucket, now = Date.now(), limit = 10) {
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
    if (["finalizing", "finalized"].includes(stored.value.status)) fail("Este pacote já está sendo finalizado e não pode ser cancelado.", 409);
    if (stored.value.status !== "cancelled") {
      await replace(c.env.CUSTOM_GAMES, sessionKey(stored.value.id), { ...stored.value, status: "cancelled" }, stored.etag);
    }
    const entries = await removeSessionObjects(c.env.CUSTOM_GAMES, stored.value);
    console.log("[CustomGamesUpload] cancelled", { sessionId: stored.value.id, gameId: stored.value.gameId, objects: entries.length });
    return c.json({ success: true, status: "cancelled" });
  });
}
