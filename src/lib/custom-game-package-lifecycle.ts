import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../types";

const UUID = "[a-f0-9-]{36}";
const FILE_KEY = new RegExp(`^(?:game-files/${UUID}|${UUID}/files/${UUID})$`, "i");
const MANIFEST_KEY = new RegExp(`^(?:manifests/${UUID}|${UUID}/manifests/${UUID})\\.json$`, "i");
const SCOPED_KEY = new RegExp(`^(${UUID})/(?:files|manifests)/`, "i");
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;

type StoredFile = { key: string; path: string; sizeBytes: number; id?: string; sha256?: string; etag?: string };
type StoredMember = { path: string; sizeBytes: number; sha256: string };
type StoredBundle = { key: string; sizeBytes: number; id?: string; sha256: string; etag?: string; files: StoredMember[] };
type StoredManifest = { version: number; totalSizeBytes: number; files: StoredFile[]; bundles?: StoredBundle[] };

function fail(message: string): never { throw new HTTPException(409, { message }); }

export function folderManifestObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Não foi possível conferir as referências do pacote de pasta.");
  const manifest = value as StoredManifest;
  if (!Array.isArray(manifest.files) || (manifest.bundles !== undefined && !Array.isArray(manifest.bundles)) ||
    manifest.files.length > 100_000 || (manifest.bundles?.length || 0) > 2500) fail("Não foi possível conferir as referências do pacote de pasta.");
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
    const object = await env.CUSTOM_GAMES.get(key);
    if (!object || object.size > MAX_MANIFEST_BYTES) fail("Não foi possível ler uma versão ainda referenciada; a limpeza foi interrompida.");
    let contents: unknown;
    try { contents = await object.json(); } catch { fail("Uma versão referenciada possui manifesto inválido; a limpeza foi interrompida."); }
    for (const member of folderManifestObjectKeys(contents)) if (remaining.delete(member)) referenced.add(member);
    if (!remaining.size) break;
  }
  return referenced;
}

function sameFields(left: object, right: object, fields: string[]) {
  return fields.every(field => (left as Record<string, unknown>)[field] === (right as Record<string, unknown>)[field]);
}
function equivalentManifest(left: StoredManifest, right: StoredManifest): boolean {
  if (!left || left.version !== right.version || left.totalSizeBytes !== right.totalSizeBytes ||
    !Array.isArray(left.files) || left.files.length !== right.files.length ||
    !Array.isArray(left.bundles) || left.bundles.length !== right.bundles?.length) return false;
  if (left.files.some((file, index) => !file || !sameFields(file, right.files[index]!, ["id", "path", "key", "sizeBytes", "sha256", "etag"]))) return false;
  return left.bundles.every((bundle, index) => {
    const expected = right.bundles![index]!;
    return bundle && sameFields(bundle, expected, ["id", "key", "sizeBytes", "sha256", "etag"]) && Array.isArray(bundle.files) &&
      bundle.files.length === expected.files.length && bundle.files.every((file, fileIndex) =>
        file && sameFields(file, expected.files[fileIndex]!, ["path", "sizeBytes", "sha256"]));
  });
}

/** Publishing a manifest is create-only. A lost response may replay identical content. */
export async function putImmutableFolderManifest(env: AppBindings, key: string, manifest: StoredManifest) {
  const serialized = JSON.stringify(manifest);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MANIFEST_BYTES) fail("Manifesto de pasta acima do limite.");
  const created = await env.CUSTOM_GAMES.put(key, serialized, {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
  });
  if (created) return created;
  const existing = await env.CUSTOM_GAMES.get(key);
  if (!existing || existing.size > MAX_MANIFEST_BYTES) fail("A chave deste manifesto já foi usada. Gere um novo pacote.");
  let previous: StoredManifest;
  try { previous = await existing.json<StoredManifest>(); } catch { fail("A chave deste manifesto já foi usada. Gere um novo pacote."); }
  if (!equivalentManifest(previous, manifest)) fail("A chave deste manifesto já pertence a outro conteúdo. Gere um novo pacote.");
  return existing;
}
