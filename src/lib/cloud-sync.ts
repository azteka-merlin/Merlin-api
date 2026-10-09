import type { AppContext } from "../types";
import { requireLauncherLicense } from "./launcher-auth";

// CloudRedirect speaks path-style S3. This facade never exposes R2 credentials
// to clients. Stage and production use separate prefixes in the shared bucket.
const VIRTUAL_BUCKET = "merlin-cloud";
const LEASE_SECONDS = 20 * 60;
const MAX_PUT_BYTES = 32 * 1024 * 1024;
const MAX_DAILY_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RECOVERY_COPIES_PER_FILE = 2;
const encoder = new TextEncoder();

type CloudClient = {
  access_key_id: string;
  hwid_digest: string;
  lease_expires_at: string;
  revoked_at: string | null;
  status: string;
  license_expires_at: string;
  license_hwid: string | null;
};

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}


async function hmac(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

async function clientSecret(master: string, accessKeyId: string): Promise<string> {
  return hex(await hmac(master, `merlin-cloud-s3:v1:${accessKeyId}`));
}

function storagePrefix(c: AppContext): string | null {
  const environment = (c.env as AppContext["env"] & { ENVIRONMENT?: string }).ENVIRONMENT;
  return environment === "staging" ? "cloud-sync/stage/"
    : environment === "production" ? "cloud-sync/production/" : null;
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char] || char);
}

function s3Error(status: number, code: string, message: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`, {
    status,
    headers: { "content-type": "application/xml", "cache-control": "no-store" },
  });
}

function fixedTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function randomKeyId(): string {
  return `MCL${hex(crypto.getRandomValues(new Uint8Array(20)))}`;
}

export async function issueCloudCredentials(c: AppContext): Promise<Response> {
  if (!storagePrefix(c)) return s3Error(404, "NotFound", "Cloud sync is not enabled here");
  const license = await requireLauncherLicense(c);
  const payload: { accessKeyId?: unknown } = await c.req.json<{ accessKeyId?: unknown }>().catch(() => ({}));
  const previousId = typeof payload.accessKeyId === "string" && /^MCL[a-f0-9]{40}$/.test(payload.accessKeyId)
    ? payload.accessKeyId : null;
  const hwidDigest = await sha256(license.hwid);
  let accessKeyId = randomKeyId();
  if (previousId) {
    const previous = await c.env.merlin_db.prepare(
      "SELECT access_key_id FROM cloud_sync_clients WHERE access_key_id = ? AND hwid_digest = ? AND revoked_at IS NULL",
    ).bind(previousId, hwidDigest).first<{ access_key_id: string }>();
    if (previous) accessKeyId = previous.access_key_id;
  }
  const expiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  // One active gateway key per licensed installation. A lost local key may be
  // replaced, but the prior lease must not remain usable in parallel.
  await c.env.merlin_db.prepare(`
    UPDATE cloud_sync_clients SET revoked_at = ?
    WHERE license_id = ? AND hwid_digest = ? AND access_key_id <> ? AND revoked_at IS NULL
  `).bind(new Date().toISOString(), license.id, hwidDigest, accessKeyId).run();
  await c.env.merlin_db.prepare(`
    INSERT INTO cloud_sync_clients(access_key_id, license_id, hwid_digest, created_at, lease_expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(access_key_id) DO UPDATE SET license_id = excluded.license_id,
      lease_expires_at = excluded.lease_expires_at
  `).bind(accessKeyId, license.id, hwidDigest, new Date().toISOString(), expiresAt).run();
  return c.json({
    success: true,
    accessKeyId,
    secretAccessKey: await clientSecret(c.env.JWT_SECRET, accessKeyId),
    endpoint: new URL(c.req.url).origin,
    bucket: VIRTUAL_BUCKET,
    keyPrefix: "steam/",
    region: "us-east-1",
    expiresAt,
    renewAfterSeconds: 300,
  }, 200, { "Cache-Control": "no-store" });
}

export async function revokeCloudCredentials(c: AppContext): Promise<Response> {
  if (!storagePrefix(c)) return s3Error(404, "NotFound", "Cloud sync is not enabled here");
  const license = await requireLauncherLicense(c);
  const payload: { accessKeyId?: unknown } = await c.req.json<{ accessKeyId?: unknown }>().catch(() => ({}));
  if (typeof payload.accessKeyId !== "string" || !/^MCL[a-f0-9]{40}$/.test(payload.accessKeyId)) {
    return c.json({ success: false, error: "Invalid access key" }, 400);
  }
  const hwidDigest = await sha256(license.hwid);
  await c.env.merlin_db.prepare(`
    UPDATE cloud_sync_clients SET revoked_at = ?
    WHERE access_key_id = ? AND hwid_digest = ? AND license_id = ?
  `).bind(new Date().toISOString(), payload.accessKeyId, hwidDigest, license.id).run();
  return c.json({ success: true }, 200, { "Cache-Control": "no-store" });
}

type Signature = { accessKeyId: string; date: string; region: string; signedHeaders: string[]; signature: string };

export function parseSignature(request: Request): Signature | null {
  const authorization = request.headers.get("authorization") || "";
  const match = /^AWS4-HMAC-SHA256 Credential=(MCL[a-f0-9]{40})\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(authorization);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4] || !match[5]) return null;
  const signedHeaders = match[4].split(";");
  if (signedHeaders.join(";") !== [...new Set(signedHeaders)].sort().join(";")) return null;
  if (!["host", "x-amz-content-sha256", "x-amz-date"].every((name) => signedHeaders.includes(name))) return null;
  return { accessKeyId: match[1], date: match[2], region: match[3], signedHeaders, signature: match[5] };
}

export async function verifySignature(request: Request, master: string, signature: Signature): Promise<boolean> {
  if (signature.region !== "us-east-1") return false;
  const url = new URL(request.url);
  const amzDate = request.headers.get("x-amz-date") || "";
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(signature.date)) return false;
  const issuedAt = Date.UTC(
    Number(amzDate.slice(0, 4)), Number(amzDate.slice(4, 6)) - 1, Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)), Number(amzDate.slice(11, 13)), Number(amzDate.slice(13, 15)),
  );
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 5 * 60_000) return false;
  const payloadHash = request.headers.get("x-amz-content-sha256") || "";
  if (payloadHash !== "UNSIGNED-PAYLOAD") return false;
  let canonicalHeaders = "";
  for (const name of signature.signedHeaders) {
    const value = name === "host" ? url.host : request.headers.get(name);
    if (value === null) return false;
    canonicalHeaders += `${name}:${value.trim().replace(/ +/g, " ")}\n`;
  }
  const canonicalRequest = [
    request.method.toUpperCase(), url.pathname, url.search.slice(1), canonicalHeaders,
    signature.signedHeaders.join(";"), payloadHash,
  ].join("\n");
  const scope = `${signature.date}/${signature.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`;
  const secret = await clientSecret(master, signature.accessKeyId);
  const dateKey = await hmac(`AWS4${secret}`, signature.date);
  const regionKey = await hmac(dateKey, signature.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const expected = hex(await hmac(signingKey, stringToSign));
  return fixedTimeEqual(expected, signature.signature);
}

async function activeClient(c: AppContext, accessKeyId: string): Promise<boolean> {
  const client = await c.env.merlin_db.prepare(`
    SELECT c.access_key_id, c.hwid_digest, c.lease_expires_at, c.revoked_at,
      l.status, l.expires_at AS license_expires_at, l.hwid AS license_hwid
    FROM cloud_sync_clients c JOIN licenses l ON l.id = c.license_id
    WHERE c.access_key_id = ? LIMIT 1
  `).bind(accessKeyId).first<CloudClient>();
  return Boolean(client && !client.revoked_at && client.status === "active"
    && Date.parse(client.lease_expires_at) > Date.now()
    && Date.parse(client.license_expires_at) >= Date.now()
    && client.license_hwid && await sha256(client.license_hwid) === client.hwid_digest);
}

export function objectKey(pathname: string): string | null {
  const prefix = `/${VIRTUAL_BUCKET}/`;
  if (!pathname.startsWith(prefix)) return null;
  let key: string;
  try { key = decodeURIComponent(pathname.slice(prefix.length)); } catch { return null; }
  // CloudRedirect reserves AppID 0 for account-scoped cloud metadata.
  if (key.length > 1024 || !/^steam\/[1-9]\d{0,9}\/(?:0|[1-9]\d{0,9})\/.+/.test(key)) return null;
  if (key.includes("\\") || /[\x00-\x1f]/.test(key) || key.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return key;
}

function listPrefix(raw: string | null): string | null {
  // The provider lists by account/app; never permit a bucket-wide index.
  if (raw === null || !/^steam\/[1-9]\d{0,9}\//.test(raw) || raw.length > 200) return null;
  if (raw.includes("\\") || /[\x00-\x1f]/.test(raw) || raw.split("/").some((part) => part === "." || part === "..")) return null;
  return raw;
}

async function backupExisting(c: AppContext, key: string): Promise<void> {
  const storage = storagePrefix(c);
  if (!storage) return;
  const old = await c.env.MERLIN_FILES.get(key);
  if (!old) return;
  const logicalKey = key.startsWith(storage) ? key.slice(storage.length) : key;
  const scope = /^steam\/([1-9]\d{0,9})\/([1-9]\d{0,9})\//.exec(logicalKey);
  if (!scope) return;
  const recoveryPrefix = `${storage}recovery/steam/${scope[1]}/${scope[2]}/${await sha256(logicalKey)}/`;
  let snapshotId = String(Date.now());
  try {
    const state = await c.env.MERLIN_FILES.get(`${storage}${logicalKey.split("/").slice(0, 3).join("/")}/state.cloudredirect`);
    if (state) {
      const parsed = JSON.parse(await state.text()) as { cn?: unknown };
      if (Number.isSafeInteger(parsed.cn) && Number(parsed.cn) >= 0) snapshotId = String(parsed.cn);
    }
  } catch (_) { /* A missing/invalid state must not block the save write. */ }
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;
  await c.env.MERLIN_FILES.put(`${recoveryPrefix}${suffix}`, old.body, {
    customMetadata: {
      originalKey: logicalKey,
      originalEtag: old.etag,
      originalSize: String(old.size),
      snapshotId,
    },
  });

  // Keep a small rolling safety net per save. Recovery objects are deliberately
  // hidden from the virtual S3 listing; they are only for operator-assisted
  // restoration after an accidental overwrite or delete.
  try {
    const recoveryObjects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.MERLIN_FILES.list({ prefix: recoveryPrefix, cursor, limit: 1000 });
      recoveryObjects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    recoveryObjects.sort((a, b) => {
      const byDate = b.uploaded.getTime() - a.uploaded.getTime();
      return byDate || b.key.localeCompare(a.key);
    });
    for (const object of recoveryObjects.slice(MAX_RECOVERY_COPIES_PER_FILE)) {
      await c.env.MERLIN_FILES.delete(object.key);
    }
  } catch (error) {
    // Retention must never make the user's save operation fail. The newly
    // created backup remains available and can be cleaned on the next write.
    console.error("[cloud-sync:recovery-retention]", { error });
  }
}

type CloudStateFile = { sha?: unknown; size?: unknown; ts?: unknown };
type CloudState = { cn?: unknown; files?: Record<string, CloudStateFile>; session?: { client_id?: unknown; op?: unknown } };

function parseCloudScope(c: AppContext, accountId: string, appId: string): { accountId: string; appId: string; prefix: string } | null {
  const storage = storagePrefix(c);
  if (!storage || !/^[1-9]\d{0,9}$/.test(accountId) || !/^[1-9]\d{0,9}$/.test(appId)) return null;
  return { accountId, appId, prefix: `${storage}steam/${accountId}/${appId}/` };
}

async function listR2Objects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
    pages += 1;
  } while (cursor && pages < 20);
  return objects;
}

async function readCloudState(bucket: R2Bucket, scope: { prefix: string }): Promise<{ state: CloudState; object: R2ObjectBody } | null> {
  const object = await bucket.get(`${scope.prefix}state.cloudredirect`);
  if (!object) return null;
  try {
    const state = JSON.parse(await object.text()) as CloudState;
    if (!state.files || typeof state.files !== "object") return null;
    return { state, object };
  } catch (_) {
    return null;
  }
}

type RecoveryFile = {
  objectKey: string;
  originalKey: string;
  filePath: string;
  digest: string;
  size: number;
  uploaded: Date;
};

type RecoveryGroup = {
  id: string;
  createdAt: Date;
  totalSize: number;
  fileCount: number;
  files: RecoveryFile[];
};

function parseRecoveryBlobKey(originalKey: string, scope: { accountId: string; appId: string }): { filePath: string; digest: string } | null {
  const prefix = `steam/${scope.accountId}/${scope.appId}/blobs/`;
  if (!originalKey.startsWith(prefix)) return null;
  const relative = originalKey.slice(prefix.length);
  const separator = relative.lastIndexOf("/");
  if (separator <= 0) return null;
  const filePath = relative.slice(0, separator);
  const digest = relative.slice(separator + 1);
  if (!/^[a-f0-9]{40}$/.test(digest) || filePath.includes("\\")
    || /[\x00-\x1f]/.test(filePath) || filePath.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { filePath, digest };
}

async function listRecoveryGroups(c: AppContext, scope: { accountId: string; appId: string }, current: CloudState): Promise<RecoveryGroup[]> {
  const prefix = `${storagePrefix(c)}recovery/steam/${scope.accountId}/${scope.appId}/`;
  const objects = await listR2Objects(c.env.MERLIN_FILES, prefix);
  const groups = new Map<string, RecoveryFile[]>();
  for (const object of objects) {
    const head = await c.env.MERLIN_FILES.head(object.key);
    const originalKey = head?.customMetadata?.originalKey || "";
    const parsed = parseRecoveryBlobKey(originalKey, scope);
    if (!parsed) continue;
    const snapshotId = head?.customMetadata?.snapshotId || "legacy";
    // CN alone is not a backup boundary: CloudRedirect can overwrite blobs
    // many minutes before publishing a new state with the same CN. Group
    // nearby file copies instead, and leave state/cn metadata out of the UI.
    const minute = Math.floor(object.uploaded.getTime() / 60_000);
    const groupKey = `${snapshotId}:${minute}`;
    const files = groups.get(groupKey) || [];
    files.push({ objectKey: object.key, originalKey, ...parsed, size: object.size, uploaded: object.uploaded });
    groups.set(groupKey, files);
  }
  const result: RecoveryGroup[] = [];
  for (const [groupKey, files] of groups) {
    if (!files.length) continue;
    files.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());
    const selected = new Map<string, RecoveryFile>();
    for (const file of files) if (!selected.has(file.filePath)) selected.set(file.filePath, file);
    const restorable = [...selected.values()].filter((file) => current.files?.[file.filePath]?.sha !== file.digest);
    const firstFile = restorable[0];
    if (!firstFile) continue;
    const createdAt = restorable.reduce((latest, item) => item.uploaded > latest ? item.uploaded : latest, firstFile.uploaded);
    result.push({
      id: await sha256(`${scope.accountId}/${scope.appId}/${groupKey}`),
      createdAt,
      totalSize: restorable.reduce((total, file) => total + file.size, 0),
      fileCount: restorable.length,
      files: restorable,
    });
  }
  return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 2);
}

function stateSummary(state: CloudState, updatedAt: Date) {
  const files = Object.values(state.files || {}).filter((item) => item && typeof item === "object");
  return {
    createdAt: updatedAt.toISOString(),
    fileCount: files.length,
    totalSize: files.reduce((total, item) => total + (Number.isSafeInteger(item.size) ? Number(item.size) : 0), 0),
  };
}

export async function listCloudGames(c: AppContext): Promise<Response> {
  const storage = storagePrefix(c);
  if (!storage) return c.json({ success: false, error: "Cloud sync is not enabled here" }, 404);
  await requireLauncherLicense(c);
  const accountId = c.req.query("accountId") || "";
  if (!/^[1-9]\d{0,9}$/.test(accountId)) return c.json({ success: false, error: "Invalid Steam account" }, 400);
  const prefix = `${storage}steam/${accountId}/`;
  const objects = await listR2Objects(c.env.MERLIN_FILES, prefix);
  const stateObjects = objects.filter((item) => /\/state\.cloudredirect$/.test(item.key));
  const games = [];
  for (const object of stateObjects.slice(0, 100)) {
    const match = new RegExp(`^${storage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}steam/${accountId}/([1-9]\\d{0,9})/state\\.cloudredirect$`).exec(object.key);
    if (!match) continue;
    const appId = match[1] || "";
    const scope = parseCloudScope(c, accountId, appId);
    if (!scope) continue;
    const current = await readCloudState(c.env.MERLIN_FILES, scope);
    if (!current) continue;
    const backups = await listRecoveryGroups(c, scope, current.state);
    const game = await c.env.merlin_db.prepare(
      "SELECT name, cover_url FROM catalog_games WHERE app_id = ? LIMIT 1",
    ).bind(appId).first<{ name?: string; cover_url?: string | null }>();
    games.push({
      appId,
      name: game?.name || `Steam App ${appId}`,
      coverUrl: game?.cover_url || null,
      lastSyncAt: object.uploaded.toISOString(),
      synced: true,
      currentVersion: stateSummary(current.state, object.uploaded),
      backupCount: backups.length,
    });
  }
  games.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ success: true, games }, 200, { "Cache-Control": "no-store" });
}

export async function getCloudGame(c: AppContext): Promise<Response> {
  if (!storagePrefix(c)) return c.json({ success: false, error: "Cloud sync is not enabled here" }, 404);
  await requireLauncherLicense(c);
  const accountId = c.req.query("accountId") || "";
  const appId = c.req.param("appId") || "";
  const scope = parseCloudScope(c, accountId, appId);
  if (!scope) return c.json({ success: false, error: "Invalid cloud game" }, 400);
  const current = await readCloudState(c.env.MERLIN_FILES, scope);
  if (!current) return c.json({ success: false, error: "Cloud game not found" }, 404);
  const backups = await listRecoveryGroups(c, scope, current.state);
  const game = await c.env.merlin_db.prepare(
    "SELECT name, cover_url FROM catalog_games WHERE app_id = ? LIMIT 1",
  ).bind(appId).first<{ name?: string; cover_url?: string | null }>();
  return c.json({
    success: true,
    game: {
      appId,
      name: game?.name || `Steam App ${appId}`,
      coverUrl: game?.cover_url || null,
      synced: true,
      currentVersion: stateSummary(current.state, current.object.uploaded),
      backups: backups.map((backup) => ({
        id: backup.id,
        createdAt: backup.createdAt.toISOString(),
        fileCount: backup.fileCount,
        totalSize: backup.totalSize,
      })),
    },
  }, 200, { "Cache-Control": "no-store" });
}

export async function restoreCloudGame(c: AppContext): Promise<Response> {
  if (!storagePrefix(c)) return c.json({ success: false, error: "Cloud sync is not enabled here" }, 404);
  await requireLauncherLicense(c);
  const body: { accountId?: unknown; appId?: unknown; recoveryId?: unknown } = await c.req.json().catch(() => ({}));
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const appId = typeof body.appId === "string" ? body.appId : "";
  const recoveryId = typeof body.recoveryId === "string" ? body.recoveryId : "";
  const scope = parseCloudScope(c, accountId, appId);
  if (!scope || !/^[a-f0-9]{64}$/.test(recoveryId)) return c.json({ success: false, error: "Invalid recovery" }, 400);
  const current = await readCloudState(c.env.MERLIN_FILES, scope);
  if (!current) return c.json({ success: false, error: "Cloud game not found" }, 404);
  if (current.state.session?.client_id && current.state.session.op) {
    return c.json({ success: false, code: "game_active", error: "Close the game before restoring its save" }, 409);
  }
  const backup = (await listRecoveryGroups(c, scope, current.state)).find((item) => item.id === recoveryId);
  if (!backup) return c.json({ success: false, code: "recovery_not_found", error: "Recovery not found" }, 404);
  const nextState: CloudState = JSON.parse(JSON.stringify(current.state));
  delete nextState.session;
  // A recovery group holds only the files replaced in that save operation.
  // Preserve every other file in the current index. Verify both old copies
  // and the current versions before changing the published state.
  for (const file of backup.files) {
    if (!await c.env.MERLIN_FILES.head(file.objectKey)) {
      return c.json({ success: false, code: "recovery_incomplete", error: "Recovery blob is unavailable" }, 409);
    }
    const currentDigest = current.state.files?.[file.filePath]?.sha;
    if (typeof currentDigest === "string" && /^[a-f0-9]{40}$/.test(currentDigest)
      && !await c.env.MERLIN_FILES.head(`${scope.prefix}blobs/${file.filePath}/${currentDigest}`)) {
      return c.json({ success: false, code: "recovery_incomplete", error: "Current blob is unavailable" }, 409);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  for (const file of backup.files) {
    const currentDigest = current.state.files?.[file.filePath]?.sha;
    if (typeof currentDigest === "string" && /^[a-f0-9]{40}$/.test(currentDigest)) {
      await backupExisting(c, `${scope.prefix}blobs/${file.filePath}/${currentDigest}`);
    }
    const oldCopy = await c.env.MERLIN_FILES.get(file.objectKey);
    if (!oldCopy) return c.json({ success: false, code: "recovery_incomplete", error: "Recovery blob is unavailable" }, 409);
    await c.env.MERLIN_FILES.put(`${scope.prefix}blobs/${file.filePath}/${file.digest}`, oldCopy.body);
    nextState.files![file.filePath] = {
      ...(current.state.files?.[file.filePath] || {}), sha: file.digest, size: file.size, ts: now,
    };
  }
  nextState.cn = (Number.isSafeInteger(current.state.cn) ? Number(current.state.cn) : 0) + 1;
  await backupExisting(c, `${scope.prefix}state.cloudredirect`);
  await c.env.MERLIN_FILES.put(`${scope.prefix}state.cloudredirect`, JSON.stringify(nextState), {
    httpMetadata: { contentType: "application/json" },
  });
  await c.env.MERLIN_FILES.put(`${scope.prefix}cn.cloudredirect`, String(nextState.cn));
  return c.json({ success: true, restoredAt: new Date().toISOString(), fileCount: backup.fileCount }, 200, { "Cache-Control": "no-store" });
}

async function chargeUpload(c: AppContext, accessKeyId: string, bytes: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const current = await c.env.merlin_db.prepare(
    "SELECT bytes_uploaded FROM cloud_sync_daily_uploads WHERE access_key_id = ? AND day = ?",
  ).bind(accessKeyId, day).first<{ bytes_uploaded: number }>();
  if ((current?.bytes_uploaded || 0) + bytes > MAX_DAILY_UPLOAD_BYTES) return false;
  await c.env.merlin_db.prepare(`
    INSERT INTO cloud_sync_daily_uploads(access_key_id, day, bytes_uploaded) VALUES (?, ?, ?)
    ON CONFLICT(access_key_id, day) DO UPDATE SET bytes_uploaded = bytes_uploaded + excluded.bytes_uploaded
  `).bind(accessKeyId, day, bytes).run();
  return true;
}

function readBodyLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : null;
}

async function readCheckedBody(request: Request, limit = MAX_PUT_BYTES): Promise<Uint8Array | Response> {
  const length = readBodyLength(request);
  if (length !== null && length > limit) return s3Error(413, "EntityTooLarge", "Upload part is too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        return s3Error(413, "EntityTooLarge", "Upload part is too large");
      }
      chunks.push(value);
    }
  }
  if (length !== null && received !== length) return s3Error(400, "BadDigest", "Body length does not match");
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const checksum = request.headers.get("x-amz-checksum-sha256");
  if (checksum) {
    const actual = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", body))));
    if (!fixedTimeEqual(actual, checksum)) return s3Error(400, "BadDigest", "SHA-256 checksum does not match");
  }
  return body;
}

function listXml(bucket: string, prefix: string, result: R2Objects, storage: string): string {
  const contents = result.objects.map((item) => {
    const key = item.key.slice(storage.length);
    return `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${item.uploaded.toISOString()}</LastModified><ETag>${xmlEscape(item.httpEtag)}</ETag><Size>${item.size}</Size></Contents>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>${result.truncated}</IsTruncated>${result.truncated && result.cursor ? `<NextContinuationToken>${xmlEscape(result.cursor)}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`;
}

function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml", "cache-control": "no-store", ...headers } });
}

function parseCompletionParts(xml: string): R2UploadedPart[] | null {
  const parts: R2UploadedPart[] = [];
  for (const match of xml.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>\s*<\/Part>/g)) {
    const partNumber = Number(match[1]);
    const etag = (match[2] || "").replace(/^"|"$/g, "");
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !/^[a-f0-9-]{16,80}$/i.test(etag)) return null;
    parts.push({ partNumber, etag });
  }
  if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1)) return null;
  return parts;
}

export async function handleCloudGateway(c: AppContext): Promise<Response> {
  const storage = storagePrefix(c);
  if (!storage) return s3Error(404, "NoSuchBucket", "Cloud sync is not enabled here");
  const request = c.req.raw;
  const signature = parseSignature(request);
  if (!signature || !await activeClient(c, signature.accessKeyId)
      || !await verifySignature(request, c.env.JWT_SECRET, signature)) {
    return s3Error(403, "AccessDenied", "Cloud session is invalid or expired");
  }

  const url = new URL(request.url);
  const key = objectKey(url.pathname);
  const isBucketRoot = url.pathname === `/${VIRTUAL_BUCKET}` || url.pathname === `/${VIRTUAL_BUCKET}/`;
  const query = url.searchParams;
  const bucket = c.env.MERLIN_FILES;

  if (isBucketRoot && request.method === "GET" && query.has("versioning")) {
    // Server-side recovery copies are deliberately not exposed as S3 versions.
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration/>');
  }
  if (isBucketRoot && request.method === "GET" && query.get("list-type") === "2") {
    const prefix = listPrefix(query.get("prefix"));
    if (!prefix) return s3Error(400, "InvalidArgument", "Invalid list prefix");
    const result = await bucket.list({ prefix: storage + prefix, cursor: query.get("continuation-token") || undefined, limit: 1000 });
    return xmlResponse(listXml(VIRTUAL_BUCKET, prefix, result, storage));
  }
  if (!key) return s3Error(400, "InvalidArgument", "Invalid object key");
  const storageKey = storage + key;
  const uploadId = query.get("uploadId");

  try {
    if (request.method === "POST" && query.has("uploads") && !uploadId) {
      const upload = await bucket.createMultipartUpload(storageKey);
      return xmlResponse(`<InitiateMultipartUploadResult><Bucket>${VIRTUAL_BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(upload.uploadId)}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (uploadId && (uploadId.length < 8 || uploadId.length > 512 || !/^[\x21-\x7e]+$/.test(uploadId))) {
      return s3Error(400, "InvalidArgument", "Invalid upload ID");
    }
    if (request.method === "PUT" && uploadId && query.has("partNumber")) {
      const partNumber = Number(query.get("partNumber"));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return s3Error(400, "InvalidArgument", "Invalid part number");
      const body = await readCheckedBody(request);
      if (body instanceof Response) return body;
      if (!await chargeUpload(c, signature.accessKeyId, body.byteLength)) return s3Error(429, "SlowDown", "Daily cloud upload limit reached");
      const part = await bucket.resumeMultipartUpload(storageKey, uploadId).uploadPart(partNumber, body);
      return new Response(null, { status: 200, headers: { ETag: `"${part.etag}"`, "cache-control": "no-store" } });
    }
    if (request.method === "POST" && uploadId) {
      const completionBody = await readCheckedBody(request, 128 * 1024);
      if (completionBody instanceof Response) return completionBody;
      const parts = parseCompletionParts(new TextDecoder().decode(completionBody));
      if (!parts) return s3Error(400, "MalformedXML", "Invalid multipart completion");
      await backupExisting(c, storageKey);
      const object = await bucket.resumeMultipartUpload(storageKey, uploadId).complete(parts);
      return xmlResponse(`<CompleteMultipartUploadResult><Bucket>${VIRTUAL_BUCKET}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(object.httpEtag)}</ETag></CompleteMultipartUploadResult>`);
    }
    if (request.method === "DELETE" && uploadId) {
      await bucket.resumeMultipartUpload(storageKey, uploadId).abort();
      return new Response(null, { status: 204 });
    }
    if (uploadId || query.has("versionId")) return s3Error(400, "InvalidArgument", "Unsupported query");
    if (request.method === "PUT") {
      const body = await readCheckedBody(request);
      if (body instanceof Response) return body;
      if (!await chargeUpload(c, signature.accessKeyId, body.byteLength)) return s3Error(429, "SlowDown", "Daily cloud upload limit reached");
      await backupExisting(c, storageKey);
      const object = await bucket.put(storageKey, body);
      return new Response(null, { status: 200, headers: { ETag: object?.httpEtag || "", "cache-control": "no-store" } });
    }
    if (request.method === "GET") {
      const object = await bucket.get(storageKey);
      if (!object) return s3Error(404, "NoSuchKey", "Object not found");
      return new Response(object.body, { status: 200, headers: { ETag: object.httpEtag, "content-length": String(object.size), "cache-control": "no-store" } });
    }
    if (request.method === "HEAD") {
      const object = await bucket.head(storageKey);
      return new Response(null, { status: object ? 200 : 404, headers: object ? { ETag: object.httpEtag, "content-length": String(object.size), "cache-control": "no-store" } : { "cache-control": "no-store" } });
    }
    if (request.method === "DELETE") {
      await backupExisting(c, storageKey);
      await bucket.delete(storageKey);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    return s3Error(405, "MethodNotAllowed", "Method not supported");
  } catch (error) {
    // Never include object names, Steam IDs, or credentials in public errors.
    console.error("[cloud-sync:gateway]", { method: request.method, error });
    return s3Error(503, "ServiceUnavailable", "Cloud storage is temporarily unavailable");
  }
}
