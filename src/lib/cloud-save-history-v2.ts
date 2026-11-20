import type { AppContext } from "../types";

type SaveFile = { sha?: unknown; size?: unknown; ts?: unknown };
export type SaveState = { cn?: unknown; files?: Record<string, SaveFile>; session?: { client_id?: unknown; op?: unknown }; [key: string]: unknown };
export type SaveScope = { accountId: string; appId: string; prefix: string };
type Snapshot = { format: 2; createdAt: string; state: SaveState };

const MAX_VISIBLE = 10;
const SHA = /^[a-f0-9]{40}$/;
const MIN_SAVE_TIMESTAMP = Date.UTC(2000, 0, 1);

export function historyEnabled(c: AppContext): boolean {
  const environment = (c.env as AppContext["env"] & { ENVIRONMENT?: string }).ENVIRONMENT;
  return environment === "staging" || environment === "production";
}

function root(scope: SaveScope): string {
  return scope.prefix.replace(/\/steam\/[^/]+\/[^/]+\/$/, `/history-v2/steam/${scope.accountId}/${scope.appId}/`);
}

function validFiles(state: SaveState): state is SaveState & { files: Record<string, SaveFile> } {
  if (!state.files || typeof state.files !== "object" || Array.isArray(state.files)) return false;
  return Object.entries(state.files).every(([name, file]) => name.length > 0 && !name.includes("\\")
    && !/[\x00-\x1f]/.test(name) && name.split("/").every((part) => part && part !== "." && part !== "..")
    && file && typeof file === "object" && typeof file.sha === "string" && SHA.test(file.sha)
    && Number.isSafeInteger(file.size) && Number(file.size) >= 0);
}

export function saveBlobKey(scope: SaveScope, filePath: string, digest: string): string {
  return `${scope.prefix}blobs/${filePath}/${digest}`;
}

function archiveKey(scope: SaveScope, blobKey: string): string {
  return `${root(scope)}blobs/${blobKey.slice(scope.prefix.length)}`;
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    if (page.truncated && !page.cursor) throw new Error("history_list_incomplete");
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function loadSnapshot(bucket: R2Bucket, key: string): Promise<Snapshot | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const value = JSON.parse(await object.text()) as Snapshot;
    return value.format === 2 && validFiles(value.state) ? value : null;
  } catch { return null; }
}

export function visibleSnapshotDates(snapshot: Snapshot, uploaded: Date) {
  const declaredCapture = Date.parse(snapshot.createdAt);
  const captureTime = Number.isFinite(declaredCapture) ? declaredCapture : uploaded.getTime();
  let lastModified = 0;
  for (const file of Object.values(snapshot.state.files || {})) {
    // CloudRedirect stores per-file modification times as Unix seconds.
    if (typeof file?.ts !== "number" || !Number.isSafeInteger(file.ts)) continue;
    const milliseconds = file.ts * 1000;
    if (milliseconds >= MIN_SAVE_TIMESTAMP && milliseconds <= captureTime) {
      lastModified = Math.max(lastModified, milliseconds);
    }
  }
  const capturedAt = new Date(captureTime).toISOString();
  const savedAt = lastModified ? new Date(lastModified).toISOString() : null;
  return { capturedAt, savedAt, createdAt: savedAt ?? capturedAt };
}

export async function loadCurrentExportSnapshot(c: AppContext, scope: SaveScope, state: SaveState): Promise<Snapshot | null> {
  const snapshot = await loadSnapshot(c.env.MERLIN_FILES, `${root(scope)}current.json`);
  return snapshot && sameSaveFiles(snapshot.state, state) ? snapshot : null;
}

export async function captureCurrentExportSnapshot(c: AppContext, scope: SaveScope, state: SaveState): Promise<void> {
  if (!validFiles(state) || !Object.keys(state.files).length) return;
  const { session: _session, ...safeState } = state;
  await c.env.MERLIN_FILES.put(`${root(scope)}current.json`, JSON.stringify({
    format: 2, createdAt: new Date().toISOString(), state: safeState,
  } satisfies Snapshot), { httpMetadata: { contentType: "application/json" } });
}

export async function getExportBlob(c: AppContext, scope: SaveScope, state: SaveState, name: string): Promise<R2ObjectBody | null> {
  if (!validFiles(state) || !Object.prototype.hasOwnProperty.call(state.files, name)) return null;
  const bucket = c.env.MERLIN_FILES;
  const key = saveBlobKey(scope, name, String(state.files[name]!.sha));
  return (await bucket.get(key)) ?? bucket.get(archiveKey(scope, key));
}

async function visibleSnapshotObjects(c: AppContext, scope: SaveScope) {
  const objects = await listAll(c.env.MERLIN_FILES, `${root(scope)}visible/`);
  const visible = objects.sort((a, b) => b.key.localeCompare(a.key)).slice(0, MAX_VISIBLE);
  return Promise.all(visible.map(async (object) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(object.key));
    const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { key: object.key, object, id };
  }));
}

export async function findVisibleSnapshot(c: AppContext, scope: SaveScope, id: string) {
  const item = (await visibleSnapshotObjects(c, scope)).find((candidate) => candidate.id === id);
  if (!item) return null;
  const snapshot = await loadSnapshot(c.env.MERLIN_FILES, item.key);
  return snapshot ? { ...item, snapshot } : null;
}

export async function listVisibleSnapshots(c: AppContext, scope: SaveScope) {
  const visible = await visibleSnapshotObjects(c, scope);
  const result = await Promise.all(visible.map(async (item) => {
    const snapshot = await loadSnapshot(c.env.MERLIN_FILES, item.key);
    return snapshot ? { ...item, snapshot } : null;
  }));
  return result.filter((item): item is NonNullable<typeof item> => item !== null);
}

async function protectedSnapshots(c: AppContext, scope: SaveScope): Promise<Snapshot[]> {
  const visible = await listVisibleSnapshots(c, scope);
  const hidden = await loadSnapshot(c.env.MERLIN_FILES, `${root(scope)}hidden/current.json`);
  const pending = await loadSnapshot(c.env.MERLIN_FILES, `${root(scope)}pending/current.json`);
  return [...visible.map((item) => item.snapshot), ...(hidden ? [hidden] : []), ...(pending ? [pending] : [])];
}

async function sourceFor(c: AppContext, scope: SaveScope, key: string): Promise<string | null> {
  if (await c.env.MERLIN_FILES.head(key)) return key;
  const archived = archiveKey(scope, key);
  return await c.env.MERLIN_FILES.head(archived) ? archived : null;
}

async function verifyState(c: AppContext, scope: SaveScope, state: SaveState): Promise<boolean> {
  if (!validFiles(state)) return false;
  for (const [filePath, file] of Object.entries(state.files)) {
    if (!await sourceFor(c, scope, saveBlobKey(scope, filePath, String(file.sha)))) return false;
  }
  return true;
}

function fileSignature(state: SaveState): string {
  return JSON.stringify(Object.entries(state.files || {}).map(([name, file]) => [name, file?.sha, file?.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function sameSaveFiles(left: SaveState, right: SaveState): boolean {
  return validFiles(left) && validFiles(right) && fileSignature(left) === fileSignature(right);
}

export async function captureVisibleSnapshot(c: AppContext, scope: SaveScope, state: SaveState): Promise<boolean> {
  if (!validFiles(state) || Object.keys(state.files).length === 0) return false;
  const current = await listVisibleSnapshots(c, scope);
  if (current[0] && fileSignature(current[0].snapshot.state) === fileSignature(state)) return false;
  if (!await verifyState(c, scope, state)) throw new Error("snapshot_incomplete");
  const { session: _session, ...safeState } = state;
  const snapshot: Snapshot = { format: 2, createdAt: new Date().toISOString(), state: safeState };
  const sequence = Number.isSafeInteger(state.cn) ? String(state.cn).padStart(12, "0") : "000000000000";
  const key = `${root(scope)}visible/${new Date().toISOString()}-${sequence}-${crypto.randomUUID()}.json`;
  await c.env.MERLIN_FILES.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });
  return true;
}

export async function capturePendingSnapshot(c: AppContext, scope: SaveScope, state: SaveState): Promise<void> {
  if (!validFiles(state) || Object.keys(state.files).length === 0) return;
  const key = `${root(scope)}pending/current.json`;
  const existing = await loadSnapshot(c.env.MERLIN_FILES, key);
  if (existing && sameSaveFiles(existing.state, state)) return;
  if (!await verifyState(c, scope, state)) throw new Error("snapshot_incomplete");
  const { session: _session, ...safeState } = state;
  await c.env.MERLIN_FILES.put(key, JSON.stringify({ format: 2, createdAt: new Date().toISOString(), state: safeState }),
    { httpMetadata: { contentType: "application/json" } });
}

export async function clearPendingSnapshot(c: AppContext, scope: SaveScope): Promise<void> {
  await c.env.MERLIN_FILES.delete(`${root(scope)}pending/current.json`);
}

export async function captureHiddenSnapshot(c: AppContext, scope: SaveScope, state: SaveState): Promise<boolean> {
  const key = `${root(scope)}hidden/current.json`;
  if (await c.env.MERLIN_FILES.head(key)) return true;
  if (!await verifyState(c, scope, state)) return false;
  const { session: _session, ...safeState } = state;
  const created = await c.env.MERLIN_FILES.put(key, JSON.stringify({ format: 2, createdAt: new Date().toISOString(), state: safeState }),
    { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
  return Boolean(created || await c.env.MERLIN_FILES.head(key));
}

export async function protectBlob(c: AppContext, scope: SaveScope, key: string): Promise<void> {
  const snapshots = await protectedSnapshots(c, scope);
  const referenced = snapshots.some((snapshot) => Object.entries(snapshot.state.files || {}).some(([name, file]) =>
    saveBlobKey(scope, name, String(file.sha)) === key));
  if (!referenced) return;
  const archived = archiveKey(scope, key);
  if (await c.env.MERLIN_FILES.head(archived)) return;
  const object = await c.env.MERLIN_FILES.get(key);
  if (!object) throw new Error("protected_blob_missing");
  await c.env.MERLIN_FILES.put(archived, object.body);
}

export async function prepareRestore(c: AppContext, scope: SaveScope, state: SaveState): Promise<boolean> {
  if (!validFiles(state)) return false;
  const sources = await Promise.all(Object.entries(state.files).map(async ([name, file]) => ({
    destination: saveBlobKey(scope, name, String(file.sha)),
    source: await sourceFor(c, scope, saveBlobKey(scope, name, String(file.sha))),
  })));
  if (sources.some((item) => !item.source)) return false;
  for (const item of sources) {
    if (item.source === item.destination) continue;
    const archived = await c.env.MERLIN_FILES.get(item.source!);
    if (!archived) return false;
    await c.env.MERLIN_FILES.put(item.destination, archived.body);
  }
  return true;
}

export async function pruneHistory(c: AppContext, scope: SaveScope): Promise<void> {
  const bucket = c.env.MERLIN_FILES;
  const visible = (await listAll(bucket, `${root(scope)}visible/`)).sort((a, b) => b.key.localeCompare(a.key));
  for (const object of visible.slice(MAX_VISIBLE)) await bucket.delete(object.key);
  const retained = await protectedSnapshots(c, scope);
  const needed = new Set(retained.flatMap((snapshot) => Object.entries(snapshot.state.files || {}).map(([name, file]) =>
    archiveKey(scope, saveBlobKey(scope, name, String(file.sha))))));
  for (const object of await listAll(bucket, `${root(scope)}blobs/`)) {
    if (!needed.has(object.key)) await bucket.delete(object.key);
  }
}
