import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../types";

type ObjectRef = { key: string; sizeBytes: number; sha256: string; etag?: string; kind: "file" | "bundle"; parts: number[]; path?: string };
type Part = { key: string };
export type ShardedFolderIndex = { version: 4; totalSizeBytes: number; parts: Part[]; objects: Record<string, ObjectRef> };
type Entry = { kind: "file" | "bundle"; id?: string; key: string; path?: string; sizeBytes: number; sha256: string; etag?: string;
  files?: { path: string; sizeBytes: number; sha256: string }[]; fragmentIndex?: number; fragmentCount?: number };

function invalid(): never { throw new HTTPException(409, { message: "Manifesto de pasta inválido." }); }

/** Index reads remain bounded by the number of uploaded objects, not game files. */
export async function readShardedFolderIndex(env: AppBindings, archiveKey: string): Promise<ShardedFolderIndex | null> {
  const head = await env.CUSTOM_GAMES.head(archiveKey);
  if (!head) throw new HTTPException(404, { message: "Manifesto do jogo não encontrado." });
  // Old v1-v3 manifests are often huge and must never be loaded just to detect v4.
  if (head.size > 8 * 1024 * 1024) return null;
  const object = await env.CUSTOM_GAMES.get(archiveKey);
  if (!object) invalid();
  const value = await object.json<Partial<ShardedFolderIndex>>();
  if (value.version !== 4) return null;
  if (!Number.isSafeInteger(value.totalSizeBytes) || !value.totalSizeBytes || !Array.isArray(value.parts) ||
      !value.objects || typeof value.objects !== "object" || Array.isArray(value.objects)) invalid();
  const match = /^([0-9a-f-]{36})\/manifests\/([0-9a-f-]{36})\.json$/i.exec(archiveKey);
  if (!match || value.parts.length > 10000) invalid();
  const prefix = `${match[1]}/manifest-parts/${match[2]}/`;
  const seenParts = new Set<string>();
  for (const part of value.parts) {
    if (!part || typeof part.key !== "string" || !part.key.startsWith(prefix) ||
      !/^\d{6}\.json$/.test(part.key.slice(prefix.length)) || seenParts.has(part.key)) invalid();
    seenParts.add(part.key);
  }
  for (const [id, ref] of Object.entries(value.objects)) {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !ref || ref.key !== `${match[1]}/files/${id}` ||
        !["file", "bundle"].includes(ref.kind) || !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0 ||
        !/^[0-9a-f]{64}$/i.test(ref.sha256) || !Array.isArray(ref.parts) || !ref.parts.length ||
        ref.parts.some(i => !Number.isSafeInteger(i) || i < 0 || i >= value.parts!.length)) invalid();
  }
  return value as ShardedFolderIndex;
}

async function readPart(env: AppBindings, descriptor: Part): Promise<Entry[]> {
  const object = await env.CUSTOM_GAMES.get(descriptor.key);
  if (!object || object.size > 2 * 1024 * 1024) invalid();
  const value = await object.json<{ entries: Entry[] }>();
  if (!Array.isArray(value?.entries) || value.entries.length > 5000) invalid();
  return value.entries;
}

/** Stream the historical JSON contract; only one bounded part is held at a time. */
export function streamShardedFolderManifest(env: AppBindings, index: ShardedFolderIndex,
  gameId: string, archiveKey: string): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<string> {
    yield `{"success":true,"gameId":${JSON.stringify(gameId)},"archiveKey":${JSON.stringify(archiveKey)},"totalSizeBytes":${index.totalSizeBytes},"files":[`;
    let first = true;
    for (const part of index.parts) for (const entry of await readPart(env, part)) {
      if (entry.kind !== "file") continue;
      const id = entry.key.slice(-36); const ref = index.objects[id];
      if (!ref || ref.kind !== "file" || ref.key !== entry.key || ref.sizeBytes !== entry.sizeBytes || ref.sha256 !== entry.sha256 || typeof entry.path !== "string") invalid();
      yield `${first ? "" : ","}${JSON.stringify({ id, path: entry.path, sizeBytes: entry.sizeBytes, etag: ref.etag, sha256: entry.sha256 })}`;
      first = false;
    }
    yield '],"bundles":[';
    first = true;
    let active = ""; let expected = 0; let total = 0; let memberFirst = true;
    for (const part of index.parts) for (const entry of await readPart(env, part)) {
      if (entry.kind !== "bundle") { if (active) invalid(); continue; }
      const id = entry.key.slice(-36); const ref = index.objects[id];
      if (!ref || ref.kind !== "bundle" || ref.key !== entry.key || ref.sizeBytes !== entry.sizeBytes || ref.sha256 !== entry.sha256 ||
          !Array.isArray(entry.files) || !Number.isSafeInteger(entry.fragmentIndex) || !Number.isSafeInteger(entry.fragmentCount) ||
          !entry.fragmentCount || entry.fragmentCount < 1) invalid();
      if (!active) {
        if (entry.fragmentIndex !== 0) invalid();
        active = id; expected = 0; total = entry.fragmentCount; memberFirst = true;
        yield `${first ? "" : ","}{"id":${JSON.stringify(id)},"sizeBytes":${ref.sizeBytes},"sha256":${JSON.stringify(ref.sha256)},"etag":${JSON.stringify(ref.etag ?? null)},"files":[`;
        first = false;
      }
      if (active !== id || entry.fragmentIndex !== expected || entry.fragmentCount !== total) invalid();
      for (const member of entry.files) {
        yield `${memberFirst ? "" : ","}${JSON.stringify({ path: member.path, sizeBytes: member.sizeBytes, sha256: member.sha256 })}`;
        memberFirst = false;
      }
      expected++;
      if (expected === total) { yield "]}"; active = ""; }
    }
    if (active) invalid();
    yield "]}";
  }
  const iterator = chunks();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      let text = "";
      while (text.length < 65536) {
        const next = await iterator.next();
        if (next.done) { if (text) controller.enqueue(encoder.encode(text)); controller.close(); return; }
        text += next.value;
      }
      controller.enqueue(encoder.encode(text));
    } catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(undefined); } });
}

/** Stream the integrity contract without constructing its complete file array. */
export function streamShardedIntegrityManifest(env: AppBindings, index: ShardedFolderIndex,
  gameId: string, archiveKey: string): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<string> {
    yield `{"success":true,"version":1,"gameId":${JSON.stringify(gameId)},"archiveKey":${JSON.stringify(archiveKey)},"totalSizeBytes":${index.totalSizeBytes},"files":[`;
    let first = true;
    for (const part of index.parts) for (const entry of await readPart(env, part)) {
      const id = entry.key.slice(-36); const ref = index.objects[id];
      if (!ref || ref.key !== entry.key || ref.kind !== entry.kind || ref.sizeBytes !== entry.sizeBytes || ref.sha256 !== entry.sha256) invalid();
      const members = entry.kind === "file" ? [entry] : entry.files;
      if (!members) invalid();
      for (const member of members) {
        if (typeof member.path !== "string" || !Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 0 || !/^[0-9a-f]{64}$/i.test(member.sha256)) invalid();
        yield `${first ? "" : ","}${JSON.stringify({ path: member.path, sizeBytes: member.sizeBytes, sha256: member.sha256 })}`;
        first = false;
      }
    }
    yield "]}";
  }
  const iterator = chunks(); const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    try {
      let text = "";
      while (text.length < 65536) {
        const next = await iterator.next();
        if (next.done) { if (text) controller.enqueue(encoder.encode(text)); controller.close(); return; }
        text += next.value;
      }
      controller.enqueue(encoder.encode(text));
    } catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(undefined); } });
}
