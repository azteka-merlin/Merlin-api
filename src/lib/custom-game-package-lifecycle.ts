import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../types";
import { MAX_FOLDER_GAME_FILES, MAX_FOLDER_MANIFEST_BYTES } from './custom-game-limits';
import { readShardedFolderIndex } from "./custom-game-sharded-download";

const UUID = "[a-f0-9-]{36}";
const FILE_KEY = new RegExp(`^(?:game-files/${UUID}|${UUID}/files/${UUID})$`, "i");
const MANIFEST_KEY = new RegExp(`^(?:manifests/${UUID}|${UUID}/manifests/${UUID})\\.json$`, "i");
const SCOPED_KEY = new RegExp(`^(${UUID})/(?:files|manifests)/`, "i");
const MAX_MANIFEST_BYTES = MAX_FOLDER_MANIFEST_BYTES;

type StoredFile = { key: string; path: string; sizeBytes: number; id?: string; sha256?: string; etag?: string };
type StoredMember = { path: string; sizeBytes: number; sha256: string };
type StoredBundle = { key: string; sizeBytes: number; id?: string; sha256: string; etag?: string; files: StoredMember[] };
type StoredManifest = { version: number; totalSizeBytes: number; files: StoredFile[]; bundles?: StoredBundle[] };

function fail(message: string): never { throw new HTTPException(409, { message }); }

export function folderManifestObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Não foi possível conferir as referências do pacote de pasta.");
  const manifest = value as StoredManifest;
  if (!Array.isArray(manifest.files) || (manifest.bundles !== undefined && !Array.isArray(manifest.bundles)) ||
    manifest.files.length > MAX_FOLDER_GAME_FILES || (manifest.bundles?.length || 0) > 2500) fail("Não foi possível conferir as referências do pacote de pasta.");
  const keys = [];
  for (const entry of [...manifest.files, ...(manifest.bundles || [])]) {
    if (!entry || typeof entry.key !== "string" || !FILE_KEY.test(entry.key)) fail("O manifesto contém uma referência de arquivo inválida.");
    keys.push(entry.key);
  }
  return [...new Set(keys)];
}

/** Only small manifests are read. Data objects and integrity sidecars stay untouched. */
export async function referencedGameFileKeys(env: AppBindings, candidates: Iterable<string>,
  { excludingManifestKey = "", gameId }: { excludingManifestKey?: string; gameId?: string } = {}): Promise<Set<string>> {
  const remaining = new Set(candidates);
  const referenced = new Set<string>();
  if (!remaining.size) return referenced;
  // New keys belong to one game. Legacy globally named keys require consulting
  // every game's snapshots because their owner cannot be derived from the key.
  if (!gameId) {
    const scopes = new Set([...remaining].map(key => SCOPED_KEY.exec(key)?.[1] || ""));
    if (scopes.size === 1 && !scopes.has("")) gameId = [...scopes][0];
  }
  const rows = await env.merlin_db.prepare(`SELECT DISTINCT archive_key FROM (
      SELECT id AS game_id,archive_key,COALESCE(package_type,'zip') AS package_type
        FROM custom_games WHERE deleted_at IS NULL
      UNION ALL
      SELECT game_id,archive_key,package_type FROM custom_game_versions WHERE status IN ('active','retired','deleting')
    ) WHERE package_type='folder' AND archive_key!=? AND (? IS NULL OR game_id=?)`)
    .bind(excludingManifestKey, gameId || null, gameId || null).all<{ archive_key: string }>();
  for (const { archive_key: key } of rows.results) {
    if (!MANIFEST_KEY.test(key)) fail("Uma versão referenciada possui manifesto inválido; a limpeza foi interrompida.");
    let sharded;
    try { sharded = await readShardedFolderIndex(env, key); }
    catch { fail("Não foi possível ler uma versão ainda referenciada; a limpeza foi interrompida."); }
    if (sharded) {
      for (const ref of Object.values(sharded.objects)) if (remaining.delete(ref.key)) referenced.add(ref.key);
      if (!remaining.size) break;
      continue;
    }
    const object = await env.CUSTOM_GAMES.get(key);
    if (!object || object.size > MAX_MANIFEST_BYTES) fail("Não foi possível ler uma versão ainda referenciada; a limpeza foi interrompida.");
    let contents: unknown;
    try { contents = await object.json(); } catch { fail("Uma versão referenciada possui manifesto inválido; a limpeza foi interrompida."); }
    for (const member of folderManifestObjectKeys(contents)) if (remaining.delete(member)) referenced.add(member);
    if (!remaining.size) break;
  }
  return referenced;
}

function* manifestJsonParts(manifest: StoredManifest): Generator<string> {
  yield `{"version":${JSON.stringify(manifest.version)},"files":[`;
  for (let index = 0; index < manifest.files.length; index++) {
    if (index) yield ",";
    const file = manifest.files[index]!;
    yield JSON.stringify({ id: file.id, path: file.path, key: file.key, sizeBytes: file.sizeBytes,
      sha256: file.sha256, etag: file.etag });
  }
  yield "]";
  if (manifest.bundles !== undefined) {
    yield ',"bundles":[';
    for (let bundleIndex = 0; bundleIndex < manifest.bundles.length; bundleIndex++) {
      if (bundleIndex) yield ",";
      const bundle = manifest.bundles[bundleIndex]!;
      yield `{"id":${JSON.stringify(bundle.id)},"key":${JSON.stringify(bundle.key)},"sizeBytes":${JSON.stringify(bundle.sizeBytes)},"sha256":${JSON.stringify(bundle.sha256)},"files":[`;
      for (let memberIndex = 0; memberIndex < bundle.files.length; memberIndex++) {
        if (memberIndex) yield ",";
        const member = bundle.files[memberIndex]!;
        yield JSON.stringify({ path: member.path, sizeBytes: member.sizeBytes, sha256: member.sha256 });
      }
      yield `]${bundle.etag === undefined ? "" : `,"etag":${JSON.stringify(bundle.etag)}`}}`;
    }
    yield "]";
  }
  yield `,"totalSizeBytes":${JSON.stringify(manifest.totalSizeBytes)}}`;
}

function manifestStream(manifest: StoredManifest): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = manifestJsonParts(manifest);
  let byteLength = 0;
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    const chunk = encoder.encode(text);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_MANIFEST_BYTES) fail("Manifesto de pasta acima do limite.");
    controller.enqueue(chunk);
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let text = "";
      while (text.length < 64 * 1024) {
        const next = parts.next();
        if (next.done) {
          if (text) emit(controller, text);
          controller.close();
          return;
        }
        text += next.value;
      }
      emit(controller, text);
    },
    cancel() { parts.return(undefined); },
  });
}

async function streamsEqual(left: ReadableStream<Uint8Array>, right: ReadableStream<Uint8Array>) {
  const a = left.getReader();
  const b = right.getReader();
  let aChunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let bChunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let aOffset = 0; let bOffset = 0; let aDone = false; let bDone = false;
  try {
    while (true) {
      if (aOffset === aChunk.length && !aDone) {
        const next = await a.read(); aDone = next.done;
        aChunk = next.done ? new Uint8Array() : next.value; aOffset = 0;
      }
      if (bOffset === bChunk.length && !bDone) {
        const next = await b.read(); bDone = next.done;
        bChunk = next.done ? new Uint8Array() : next.value; bOffset = 0;
      }
      if (aDone || bDone) return aDone && bDone;
      const length = Math.min(aChunk.length - aOffset, bChunk.length - bOffset);
      for (let index = 0; index < length; index++) if (aChunk[aOffset + index] !== bChunk[bOffset + index]) return false;
      aOffset += length; bOffset += length;
    }
  } finally {
    await Promise.all([a.cancel().catch(() => {}), b.cancel().catch(() => {})]);
  }
}

/** Create-only publication streams large manifests instead of duplicating them in Worker memory. */
export async function putImmutableFolderManifest(env: AppBindings, key: string, manifest: StoredManifest, uploadSessionId?: string) {
  const encoder = new TextEncoder();
  let byteLength = 0;
  for (const part of manifestJsonParts(manifest)) {
    byteLength += encoder.encode(part).byteLength;
    if (byteLength > MAX_MANIFEST_BYTES) fail("Manifesto de pasta acima do limite.");
  }
  const stream = new FixedLengthStream(byteLength);
  const writing = manifestStream(manifest).pipeTo(stream.writable);
  const put = env.CUSTOM_GAMES.put(key, stream.readable, {
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: uploadSessionId ? { uploadSessionId } : undefined,
    httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
  });
  const created = await put.catch(async error => {
    await stream.readable.cancel(error).catch(() => {});
    await writing.catch(() => {});
    throw error;
  });
  if (!created) await stream.readable.cancel().catch(() => {});
  await writing.catch(error => { if (created) throw error; });
  if (created) {
    if (created.size > MAX_MANIFEST_BYTES) {
      await env.CUSTOM_GAMES.delete(key);
      fail("Manifesto de pasta acima do limite.");
    }
    return created;
  }
  const existing = await env.CUSTOM_GAMES.head(key);
  if (!existing || existing.size > MAX_MANIFEST_BYTES) fail("A chave deste manifesto já foi usada. Gere um novo pacote.");
  if (uploadSessionId && existing.customMetadata?.uploadSessionId === uploadSessionId) return existing;
  const object = await env.CUSTOM_GAMES.get(key);
  if (!object || object.size > MAX_MANIFEST_BYTES || !await streamsEqual(object.body, manifestStream(manifest))) {
    fail("A chave deste manifesto já pertence a outro conteúdo. Gere um novo pacote.");
  }
  return existing;
}
