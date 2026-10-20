import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { requireGoldLauncherLicense } from "./launcher-auth";
import { beginGameUploadFinalization, completeGameMultipart, finishGameUploadFinalization,
  registerGameUploadSessionRoutes } from "./custom-game-upload-sessions";
import { metadataFromRow, readCustomGameMetadata, portReleaseStatus, type MetadataRow } from "./custom-game-metadata";
import { ensureGameVersion, gameVersionInsertStatement, getLegacyGamePackage, resolveGamePackage,
  registerGameVersionRoutes, findGameVersion, cleanupRetiredGameVersions } from "./custom-game-versions";
import { registerCustomGameIntegrityRoutes, enqueueGameIntegrity, getIntegrityManifest, integrityManifestKey, integrityJobKey, integrityJobId, readJob, writeJob } from "./custom-game-integrity";
import { consumeCloudflareIntegrityBatch, type IntegrityQueueMessage } from "./custom-game-cloudflare-indexer";
import { folderManifestObjectKeys, putImmutableFolderManifest, referencedGameFileKeys } from "./custom-game-package-lifecycle";

const PART_SIZE = 64 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_PARTS = Math.ceil(MAX_ARCHIVE_SIZE / PART_SIZE);
const MAX_GAME_SIZE = 200 * 1024 * 1024 * 1024;
const MAX_GAME_FILE_SIZE = 30 * 1024 * 1024 * 1024;
const MAX_GAME_FILES = 100000;
const MAX_GAME_BUNDLES = 2500;
const MAX_NEW_BUNDLE_SIZE = 200 * 1024 * 1024;
const MAX_BUNDLE_MEMBER_SIZE = 200 * 1024 * 1024;
const MAX_DIRECT_FILE_SIZE = 32 * 1024 * 1024;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RANGE_SIZE = 64 * 1024 * 1024;
const MAX_FOLDER_RANGE_SIZE = 256 * 1024 * 1024;
const MAX_FOLDER_MANIFEST_SIZE = 12 * 1024 * 1024;
const UUID = "[0-9a-f-]{36}";
const GAME_ID_PATTERN = new RegExp(`^${UUID}$`);
const ARCHIVE_KEY_PATTERN = new RegExp(`^(?:archives/${UUID}|${UUID}/archives/${UUID})\\.zip$`);
const MANIFEST_KEY_PATTERN = new RegExp(`^(?:manifests/${UUID}|${UUID}/manifests/${UUID})\\.json$`);
const GAME_FILE_KEY_PATTERN = new RegExp(`^(?:game-files/${UUID}|${UUID}/files/${UUID})$`);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DRAFT_KEY_PATTERN = /^draft\/[0-9a-f-]{36}$/;
const FOLDER_MANIFEST_CACHE_MS = 60_000;
const FOLDER_MANIFEST_CACHE_SIZE = 4;
const folderManifestCache = new Map<string, { expiresAt: number; manifest: FolderManifest }>();

export function validFolderFileCount(files: unknown): files is unknown[] {
  return Array.isArray(files) && files.length >= 1 && files.length <= MAX_GAME_FILES;
}

export type GameRow = MetadataRow & {
  id: string; name: string; install_name: string; admin_note: string; admin_notes_json: string;
  image_key: string; image_position_x: number; image_position_y: number; image_zoom: number;
  archive_key: string; archive_size: number; executable_path: string | null;
  package_type?: "zip" | "folder";
  deleted_at?: string | null;
  storage_revision?: number;
  published: number; created_at: string; updated_at: string;
  pending_archive_key?: string | null; pending_source_etag?: string | null;
  pending_data_json?: string | null; pending_base_archive_key?: string | null; pending_created_at?: string | null;
};

type FolderFile = { id: string; path: string; key: string; sizeBytes: number; etag?: string; sha256?: string };
type BundleMember = { path: string; sizeBytes: number; sha256: string };
type FolderBundle = { id: string; key: string; sizeBytes: number; sha256: string; etag?: string; files: BundleMember[] };
export type FolderManifest = { version: 1 | 2 | 3; files: FolderFile[]; bundles?: FolderBundle[]; totalSizeBytes: number };

function fail(message: string, status: 400 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}

function validPackageKey(value: unknown, packageType: "zip" | "folder"): string {
  const key = String(value || "");
  if (packageType === "zip" ? !ARCHIVE_KEY_PATTERN.test(key) : !MANIFEST_KEY_PATTERN.test(key)) {
    fail("Pacote do jogo inválido.");
  }
  return key;
}

function validGameFileKey(value: unknown): string {
  const key = String(value || "");
  if (!GAME_FILE_KEY_PATTERN.test(key)) fail("Arquivo do jogo inválido.");
  return key;
}

function validGameId(value: unknown): string {
  const id = String(value || "");
  if (!GAME_ID_PATTERN.test(id)) fail("Identificador do jogo inválido.");
  return id;
}

export function belongsToGame(key: string, gameId: string): boolean {
  return !GAME_ID_PATTERN.test(key.slice(0, 36)) || key.startsWith(`${gameId}/`);
}

export function validateGameFilePath(value: unknown): string {
  const path = String(value || "").replace(/\\/g, "/");
  const parts = path.split("/");
  if (!path || path.length > 500 || path.startsWith("/") || parts.length > 32 ||
      parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) ||
      parts.some(part => part.toLowerCase() === ".merlin-install.json")) fail("O pacote contém um caminho de arquivo inválido.");
  return parts.join("/");
}

export function validateSha256(value: unknown): string {
  const checksum = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) fail("Hash SHA-256 de arquivo inválido.");
  return checksum;
}

async function loadFolderManifest(c: AppContext, key: string): Promise<FolderManifest> {
  const cached = folderManifestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.manifest;
  if (cached) folderManifestCache.delete(key);
  const object = await c.env.CUSTOM_GAMES.get(key);
  if (!object) fail("Manifesto do jogo não encontrado.", 404);
  if (object.size > MAX_FOLDER_MANIFEST_SIZE) fail("Manifesto do jogo inválido.");
  let manifest: FolderManifest;
  try { manifest = await object.json<FolderManifest>(); }
  catch { fail("Manifesto do jogo inválido."); }
  if (!manifest || ![1, 2, 3].includes(manifest.version) || !Array.isArray(manifest.files) ||
      (manifest.version === 3 ? !Array.isArray(manifest.bundles) : Boolean(manifest.bundles)) ||
      (manifest.bundles?.length || 0) > MAX_GAME_BUNDLES) fail("Manifesto do jogo inválido.");
  const memberCount = manifest.files.length + (manifest.bundles || []).reduce((sum, bundle) =>
    sum + (Array.isArray(bundle?.files) ? bundle.files.length : 0), 0);
  if (memberCount < 1 || memberCount > MAX_GAME_FILES) fail("Manifesto do jogo inválido.");
  let totalSizeBytes = 0;
  const paths = new Set<string>();
  for (const file of manifest.files) {
    file.path = validateGameFilePath(file.path);
    file.key = validGameFileKey(file.key);
    if (!/^[0-9a-f-]{36}$/i.test(file.id) || !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 || file.sizeBytes > MAX_GAME_FILE_SIZE) fail("Manifesto do jogo inválido.");
    if (manifest.version !== 1 && file.sha256 == null) fail("Manifesto do jogo inválido.");
    if (file.sha256 != null) file.sha256 = validateSha256(file.sha256);
    if (file.sizeBytes === 0 && file.sha256 !== EMPTY_SHA256) fail("Manifesto do jogo inválido.");
    const normalized = file.path.toLocaleLowerCase("en-US");
    if (paths.has(normalized)) fail("Manifesto contém caminhos duplicados.");
    paths.add(normalized);
    totalSizeBytes += file.sizeBytes;
  }
  const objectIds = new Set(manifest.files.map(file => file.id.toLowerCase()));
  for (const bundle of manifest.bundles || []) {
    if (!bundle || typeof bundle !== "object") fail("Manifesto do jogo inválido.");
    bundle.key = validGameFileKey(bundle.key);
    if (!bundle.key.startsWith(`${key.slice(0, 36)}/files/`) ||
        !GAME_ID_PATTERN.test(bundle.id) || bundle.id.toLowerCase() !== bundle.key.slice(-36).toLowerCase() ||
        objectIds.has(bundle.id.toLowerCase()) || !Number.isSafeInteger(bundle.sizeBytes) ||
        bundle.sizeBytes < 1 || bundle.sizeBytes > 1024 ** 3 ||
        !Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > 3000) fail("Manifesto do jogo inválido.");
    objectIds.add(bundle.id.toLowerCase());
    bundle.sha256 = validateSha256(bundle.sha256);
    for (const member of bundle.files) {
      member.path = validateGameFilePath(member.path);
      member.sha256 = validateSha256(member.sha256);
      if (!Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 0 || member.sizeBytes > MAX_BUNDLE_MEMBER_SIZE ||
          (member.sizeBytes === 0 && member.sha256 !== EMPTY_SHA256)) fail("Manifesto do jogo inválido.");
      const normalized = member.path.toLocaleLowerCase("en-US");
      if (paths.has(normalized)) fail("Manifesto contém caminhos duplicados.");
      paths.add(normalized);
      totalSizeBytes += member.sizeBytes;
    }
  }
  for (const normalized of paths) {
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join("/"))) fail("Manifesto contém conflito entre arquivo e pasta.");
    }
  }
  if (totalSizeBytes < 1 || totalSizeBytes > MAX_GAME_SIZE || manifest.totalSizeBytes !== totalSizeBytes) fail("Tamanho do manifesto inválido.");
  const validated: FolderManifest = { version: manifest.version, files: manifest.files,
    ...(manifest.bundles ? { bundles: manifest.bundles } : {}), totalSizeBytes };
  if (folderManifestCache.size >= FOLDER_MANIFEST_CACHE_SIZE) {
    const oldest = folderManifestCache.keys().next().value;
    if (oldest) folderManifestCache.delete(oldest);
  }
  folderManifestCache.set(key, { expiresAt: Date.now() + FOLDER_MANIFEST_CACHE_MS, manifest: validated });
  return validated;
}

async function mapConcurrent<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

async function inspectFolderObjects(bucket: R2Bucket, gameId: string,
  objects: { key: string; sizeBytes: number }[]): Promise<(R2Object | null)[]> {
  // A few objects are cheaper to check directly. Older folder uploads can have
  // thousands; R2's strongly consistent, paginated listing avoids one HEAD per file.
  if (objects.length <= 128) {
    return mapConcurrent(objects, 6, file => file.sizeBytes === 0 ? Promise.resolve(null) : bucket.head(file.key));
  }
  const remaining = new Set(objects.filter(file => file.sizeBytes > 0).map(file => file.key));
  const found = new Map<string, R2Object>();
  let cursor: string | undefined;
  for (let pageNumber = 0; remaining.size && pageNumber < 1000; pageNumber++) {
    const page = await bucket.list({ prefix: `${gameId}/files/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      if (remaining.delete(object.key)) found.set(object.key, object);
    }
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) fail("Não foi possível concluir a conferência dos arquivos.", 409);
    cursor = page.cursor;
  }
  return objects.map(file => file.sizeBytes === 0 ? null : found.get(file.key) || null);
}

async function deletePackage(c: AppContext, packageType: "zip" | "folder", key: string) {
  if (!key || DRAFT_KEY_PATTERN.test(key)) return;
  if (packageType === "zip") return c.env.CUSTOM_GAMES.delete(key);
  const object = await c.env.CUSTOM_GAMES.get(key);
  if (!object) return;
  let manifest: FolderManifest | null = null;
  try {
    manifest = await object.json<FolderManifest>();
  } catch { /* Delete the manifest even if its contents are malformed. */ }
  if (manifest) {
    const keys = folderManifestObjectKeys(manifest);
    const shared = await referencedGameFileKeys(c.env, keys, { excludingManifestKey: key });
    const unique = keys.filter(member => !shared.has(member));
    const batches = Array.from({ length: Math.ceil(unique.length / 1000) }, (_, index) =>
      unique.slice(index * 1000, (index + 1) * 1000));
    await mapConcurrent(batches, 6, batch => c.env.CUSTOM_GAMES.delete(batch));
  }
  await c.env.CUSTOM_GAMES.delete(key);
}

export function validateInstallName(name: string): string {
  const safe = name.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 90).replace(/[. ]+$/g, "");
  if (!safe || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) fail("Nome inválido para a pasta do jogo.");
  return safe;
}

export function validateExecutable(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)) ||
      !/\.exe$/i.test(raw) || raw.length > 300) fail("Informe um executável .exe relativo à pasta do jogo.");
  return raw;
}

function mapGame(row: GameRow) {
  let notes: Record<string, string> = {};
  try { notes = JSON.parse(row.admin_notes_json || "{}"); } catch { /* Legacy or malformed optional translations. */ }
  return {
    ...metadataFromRow(row),
    id: row.id, name: row.name, installName: row.install_name, adminNote: row.admin_note,
    adminNotes: notes,
    imageUrl: row.image_key ? `/api/custom-games/${row.id}/image?v=${encodeURIComponent(row.image_key)}` : "",
    imageVersion: row.image_key,
    imagePositionX: row.image_position_x, imagePositionY: row.image_position_y, imageZoom: row.image_zoom,
    archiveKey: DRAFT_KEY_PATTERN.test(row.archive_key) ? "" : row.archive_key, archiveSize: row.archive_size,
    packageType: row.package_type || "zip",
    executablePath: row.executable_path, published: Boolean(row.published),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function findGame(c: AppContext, id: string) {
  return c.env.merlin_db.prepare("SELECT * FROM custom_games WHERE id = ? LIMIT 1")
    .bind(id).first<GameRow>();
}

async function queuePublishedIntegrity(c: AppContext, game: ReturnType<typeof packageSnapshot>) {
  try { await enqueueGameIntegrity(c, { id: game.id, archive_key: game.archiveKey,
    archive_size: game.archiveSize, package_type: game.packageType }, integrityDependencies); }
  catch { console.warn("[CustomGamesIntegrity] enqueue-deferred", { gameId: game.id }); }
}

async function publishBatch(c: AppContext, statements: D1PreparedStatement[]) {
  try { return await c.env.merlin_db.batch(statements); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("custom_game_deleted")) fail("Este jogo foi removido enquanto você editava.", 404);
    if (message.includes("custom_game_version_unavailable")) fail("Este pacote já entrou na limpeza. Envie a versão novamente.", 409);
    if (message.includes("custom_game_storage_changed")) fail("O armazenamento deste jogo mudou durante a publicação. Atualize a página e tente novamente.", 409);
    if (message.includes("custom_game_pending_changed")) fail("O ZIP pendente mudou ou já foi publicado. Atualize a página e tente novamente.", 409);
    throw error;
  }
}

function packageSnapshot(id: string, data: { archiveKey: string; packageType: "zip" | "folder"; archiveSize: number;
  executablePath: string | null; origin: "native" | "port"; protectedPaths: string[]; versionLabel: string }) {
  return { id, archiveKey: data.archiveKey, packageType: data.packageType, archiveSize: data.archiveSize,
    executablePath: data.executablePath, origin: data.origin, protectedPaths: data.protectedPaths, versionLabel: data.versionLabel };
}

const integrityDependencies = {
  findGame, loadFolderManifest, validateGameFilePath, validateSha256,
  async resolveIntegrityPackage(c: AppContext, game: GameRow, archiveKey: string) {
    if (!archiveKey || archiveKey === game.archive_key) return game;
    const version = await findGameVersion(c.env, game.id, archiveKey);
    if (!version) throw Object.assign(new HTTPException(409, { message: "A versão instalada não está disponível para verificação." }), { code: "package_changed" });
    return { ...game, archive_key: version.archiveKey, package_type: version.packageType,
      archive_size: version.archiveSize, executable_path: version.executablePath };
  },
  async isPackageAvailable(c: AppContext, gameId: string, archiveKey: string) {
    const game = await findGame(c, gameId);
    const version = await findGameVersion(c.env, gameId, archiveKey);
    if (game?.archive_key === archiveKey && !game.deleted_at && !version) return true;
    if (version) return ["active", "retired"].includes(version.status);
    // Newly uploaded ZIPs are indexed before they become a published version.
    // The key is scoped to the game and the index job pins its R2 ETag.
    if (!ARCHIVE_KEY_PATTERN.test(archiveKey) || !archiveKey.startsWith(`${gameId}/`) || game?.deleted_at) return false;
    return Boolean(await c.env.CUSTOM_GAMES.head(archiveKey));
  },
};

export async function consumeCustomGameIndexQueue(batch: MessageBatch<IntegrityQueueMessage>, env: AppBindings) {
  return consumeCloudflareIntegrityBatch(batch, env, integrityDependencies);
}

export async function cleanupCustomGamePackages(env: AppBindings) {
  const c = { env } as AppContext;
  return cleanupRetiredGameVersions(env, async version => deletePackage(c, version.packageType, version.archiveKey), {
    canDelete: async version => {
      const jobObject = await env.CUSTOM_GAMES.get(await integrityJobKey(env, version.id, version.archiveKey));
      if (jobObject) {
        const job = await jobObject.json<{ status: string }>();
        if (["queued", "processing"].includes(job.status)) return false;
      }
      const snapshot = { id: version.id, archive_key: version.archiveKey, package_type: version.packageType,
        archive_size: version.archiveSize, published: 1 };
      // Keep the small integrity baseline after removing obsolete download objects.
      return Boolean(await getIntegrityManifest(c, snapshot, integrityDependencies));
    },
  });
}

function readNumber(value: string | File | null, fallback: number, min: number, max: number): number {
  const number = value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail("Enquadramento de imagem inválido.");
  return number;
}

export async function readGameForm(c: AppContext, id: string, prior?: GameRow | null,
  { allowPendingZip = false }: { allowPendingZip?: boolean } = {}) {
  const form = await c.req.formData();
  const metadata = readCustomGameMetadata(form, prior, validateGameFilePath);
  const published = form.get("published") === "true";
  const name = String(form.get("name") || "").trim();
  if ((published && !name) || name.length > 120) fail("Informe um nome de até 120 caracteres.");
  const installName = published ? validateInstallName(name) : `draft-${id}`;
  const note = String(form.get("adminNote") || "").trim();
  if (note.length > 5000) fail("A anotação deve ter até 5.000 caracteres.");
  let notes: Record<string, string>;
  try { notes = JSON.parse(String(form.get("adminNotes") || "{}")); }
  catch { fail("Traduções da anotação inválidas."); }
  if (!notes || typeof notes !== "object" || Array.isArray(notes) ||
      Object.entries(notes).some(([language, text]) => !["en", "es", "fr", "de"].includes(language) ||
        typeof text !== "string" || text.length > 5000)) fail("Traduções da anotação inválidas.");
  notes = Object.fromEntries(Object.entries(notes).map(([language, text]) => [language, text.trim()]));
  if (form.get("published") === "true" && (note || Object.values(notes).some(Boolean)) &&
      (!note || ["en", "es", "fr", "de"].some(language => !notes[language]))) {
    fail("Traduza a anotação para os quatro idiomas antes de publicar.");
  }
  const executablePath = validateExecutable(String(form.get("executablePath") || ""));
  const imagePositionX = readNumber(form.get("imagePositionX"), 50, 0, 100);
  const imagePositionY = readNumber(form.get("imagePositionY"), 50, 0, 100);
  const imageZoom = readNumber(form.get("imageZoom"), 1, 1, 4);
  const packageType = String(form.get("packageType") || prior?.package_type || "zip") as "zip" | "folder";
  if (packageType !== "zip" && packageType !== "folder") fail("Formato de jogo inválido.");
  const suppliedKey = String(form.get("archiveKey") || "");
  const archiveKey = suppliedKey ? validPackageKey(suppliedKey, packageType) : `draft/${id}`;
  if (suppliedKey && !belongsToGame(archiveKey, id)) fail("O pacote pertence a outro jogo.");
  if (suppliedKey && !suppliedKey.startsWith(`${id}/`) && suppliedKey !== prior?.archive_key) {
    const ownVersion = await findGameVersion(c.env, id, suppliedKey);
    if (!ownVersion) fail("Este pacote legado não pertence a este jogo. Faça um novo envio.");
  }
  let archiveSize = 0;
  if (suppliedKey) {
    if (packageType === "zip") {
      const archive = await c.env.CUSTOM_GAMES.head(archiveKey);
      if (!archive || !archive.size || archive.size > MAX_ARCHIVE_SIZE) fail("Envie um ZIP válido antes de salvar.");
      archiveSize = archive.size;
      // A public ZIP must already have its per-file hashes and byte offsets.
      // Keep the currently published package untouched while a replacement is indexed.
      if (published && !allowPendingZip && (!prior?.published || prior.archive_key !== archiveKey || prior.package_type !== "zip")) {
        const manifest = await getIntegrityManifest(c, { id, archive_key: archiveKey,
          archive_size: archiveSize, package_type: "zip" }, integrityDependencies);
        if (!manifest || manifest.sourceEtag !== archive.etag || manifest.sourceSize !== archive.size) {
          fail("O ZIP ainda está sendo indexado. Aguarde a conclusão antes de publicar.", 409);
        }
      }
    } else {
      const manifest = await loadFolderManifest(c, archiveKey);
      archiveSize = manifest.totalSizeBytes;
      if (archiveKey !== prior?.archive_key) {
        const objects = [...manifest.files, ...(manifest.bundles || [])];
        const heads = await inspectFolderObjects(c.env.CUSTOM_GAMES, id, objects);
        if (heads.some((head, index) => objects[index]!.sizeBytes > 0 && (!head || head.size !== objects[index]!.sizeBytes ||
            (objects[index]!.etag && objects[index]!.etag !== head.etag)))) fail("Os arquivos deste pacote não estão mais disponíveis. Faça um novo envio.", 409);
      }
    }
  } else if (published) fail("Envie o pacote do jogo antes de publicar.");
  const image = form.get("image");
  let imageKey = prior?.image_key || "";
  if (image instanceof File && image.size) {
    if (image.size > MAX_IMAGE_SIZE) fail("A imagem deve ter até 8 MB.");
    const mime = image.type.toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) fail("Use PNG, JPG ou WebP.");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const isPng = mime === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8;
    const isWebp = mime === "image/webp" && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!isPng && !isJpeg && !isWebp) fail("O arquivo de imagem não corresponde ao formato declarado.");
    imageKey = `${id}/images/${crypto.randomUUID()}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
    await c.env.CUSTOM_GAMES.put(imageKey, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=86400" } });
  }
  if (published && !imageKey) fail("Selecione uma imagem do jogo antes de publicar.");
  return {
    ...metadata,
    name, installName, note, notes: JSON.stringify(notes), executablePath, packageType, archiveKey, archiveSize, imageKey,
    imagePositionX, imagePositionY, imageZoom,
    published: published ? 1 : 0,
  };
}

type GameFormData = Awaited<ReturnType<typeof readGameForm>>;

function pendingGameData(row: GameRow): GameFormData | null {
  if (!row.pending_archive_key || !row.pending_data_json) return null;
  try {
    const data = JSON.parse(row.pending_data_json) as GameFormData;
    return data?.archiveKey === row.pending_archive_key && data.packageType === "zip" ? data : null;
  } catch { return null; }
}

async function pendingGameStatus(c: AppContext, row: GameRow) {
  const data = pendingGameData(row);
  if (!data) return null;
  const [source, sidecar, job] = await Promise.all([
    c.env.CUSTOM_GAMES.head(data.archiveKey),
    c.env.CUSTOM_GAMES.head(await integrityManifestKey(row.id, data.archiveKey)),
    readJob(c.env, await integrityJobId(row.id, data.archiveKey)),
  ]);
  const sourceMatches = Boolean(source && source.etag === row.pending_source_etag && source.size === data.archiveSize);
  const ready = sourceMatches && sidecar?.customMetadata?.sourceEtag === row.pending_source_etag;
  const indexStatus = ready ? "ready" : !sourceMatches ? "failed"
    : job?.job.status === "failed" || job?.job.status === "cancelled" ? "failed"
      : job?.job.status === "processing" ? "processing" : "queued";
  let notes: Record<string, string> = {};
  try { notes = JSON.parse(data.notes || "{}"); } catch { /* Keep the form editable. */ }
  return { archiveKey: data.archiveKey, archiveSize: data.archiveSize, name: data.name, adminNote: data.note,
    adminNotes: notes, executablePath: data.executablePath, imageKey: data.imageKey,
    imageVersion: data.imageKey, imagePositionX: data.imagePositionX, imagePositionY: data.imagePositionY,
    imageZoom: data.imageZoom, origin: data.origin, repositoryUrl: data.repositoryUrl,
    discordUrl: data.discordUrl, protectedPaths: data.protectedPaths, versionLabel: data.versionLabel,
    trackedReleaseTag: data.trackedReleaseTag, publishRequested: Boolean(data.published),
    indexStatus, error: indexStatus === "failed" ? job?.job.error || "O ZIP enviado não está disponível." : null,
    processedBytes: job?.job.processedBytes || 0, totalBytes: job?.job.totalBytes || data.archiveSize,
    processedFiles: job?.job.processedFiles || 0, totalFiles: job?.job.totalFiles || 0,
    createdAt: row.pending_created_at };
}

async function applyGameUpdate(c: AppContext, prior: GameRow, data: GameFormData, clearPending = false) {
  const changed = prior.archive_key !== data.archiveKey || (prior.package_type || "zip") !== data.packageType;
  const pendingReset = clearPending ? ",pending_archive_key=NULL,pending_source_etag=?,pending_data_json=NULL,pending_base_archive_key=NULL,pending_created_at=NULL" : "";
  const statements = [
    ...(!prior.archive_key.startsWith("draft/") ? [gameVersionInsertStatement(c.env, mapGame(prior))] : []),
    ...(!data.archiveKey.startsWith("draft/") ? [gameVersionInsertStatement(c.env, packageSnapshot(prior.id, data))] : []),
    c.env.merlin_db.prepare(`UPDATE custom_games SET name=?,install_name=?,admin_note=?,admin_notes_json=?,image_key=?,
      image_position_x=?,image_position_y=?,image_zoom=?,archive_key=?,archive_size=?,package_type=?,executable_path=?,
      published=?,origin=?,repository_url=?,discord_url=?,protected_paths_json=?,version_label=?,tracked_release_tag=?,storage_revision=?,updated_at=CURRENT_TIMESTAMP${pendingReset} WHERE id=?`).bind(data.name, data.installName, data.note, data.notes,
      data.imageKey, data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey,
      data.archiveSize, data.packageType, data.executablePath, data.published, data.origin, data.repositoryUrl,
      data.discordUrl, JSON.stringify(data.protectedPaths), data.versionLabel, data.trackedReleaseTag,
      prior.storage_revision || 0, ...(clearPending ? [prior.pending_source_etag] : []), prior.id),
    c.env.merlin_db.prepare(`UPDATE custom_game_versions SET executable_path=?,origin=?,protected_paths_json=?,version_label=?,
      status='active',retired_at=NULL,delete_after=NULL WHERE game_id=? AND archive_key=? AND status IN ('active','retired')`).bind(data.executablePath, data.origin,
        JSON.stringify(data.protectedPaths), data.versionLabel, prior.id, data.archiveKey),
    c.env.merlin_db.prepare(`UPDATE custom_game_versions SET status='retired',retired_at=?,delete_after=? WHERE game_id=? AND archive_key!=? AND status='active'`)
      .bind(new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString(), prior.id, data.archiveKey),
    ...(clearPending ? [c.env.merlin_db.prepare("UPDATE custom_games SET pending_source_etag=NULL WHERE id=? AND archive_key=?")
      .bind(prior.id, data.archiveKey)] : []),
  ];
  await publishBatch(c, statements);
  if (changed && !prior.archive_key.startsWith("draft/")) await queuePublishedIntegrity(c, mapGame(prior));
  if (prior.image_key && prior.image_key !== data.imageKey) await c.env.CUSTOM_GAMES.delete(prior.image_key);
  if (!data.archiveKey.startsWith("draft/")) await queuePublishedIntegrity(c, packageSnapshot(prior.id, data));
}

async function discardStagedZip(c: AppContext, gameId: string, key: string, activeKey: string) {
  if (!key || key === activeKey || !key.startsWith(`${gameId}/archives/`)) return;
  const record = await readJob(c.env, await integrityJobId(gameId, key));
  if (record && ["queued", "processing"].includes(record.job.status)) {
    const cancelled = { ...record.job, status: "cancelled" as const, phase: "cancelled" as const,
      updatedAt: new Date().toISOString() };
    delete cancelled.leaseToken; delete cancelled.leaseExpiresAt;
    await writeJob(c.env, cancelled, record.etag);
  }
  await c.env.CUSTOM_GAMES.delete([key, await integrityManifestKey(gameId, key)]);
}

async function publishStagedZip(c: AppContext, id: string) {
  const prior = await findGame(c, id);
  if (!prior || prior.deleted_at) fail("Jogo não encontrado.", 404);
  const data = pendingGameData(prior);
  if (!data || !data.published) fail("Este jogo não tem ZIP pronto para publicação.", 409);
  if (prior.archive_key !== prior.pending_base_archive_key) {
    fail("O jogo mudou desde o envio do ZIP. Revise a versão pendente.", 409);
  }
  const source = await c.env.CUSTOM_GAMES.head(data.archiveKey);
  if (!source || source.etag !== prior.pending_source_etag || source.size !== data.archiveSize) {
    fail("O ZIP pendente mudou ou não está mais disponível.", 409);
  }
  const manifest = await getIntegrityManifest(c, { id, archive_key: data.archiveKey,
    archive_size: data.archiveSize, package_type: "zip" }, integrityDependencies);
  if (!manifest || manifest.sourceEtag !== source.etag || manifest.sourceSize !== source.size) {
    fail("O ZIP ainda está sendo indexado. Aguarde antes de publicar.", 409);
  }
  if (!data.name || !data.imageKey || !data.installName || !data.archiveKey) {
    fail("Complete o cadastro do jogo antes de publicar.", 409);
  }
  await applyGameUpdate(c, prior, data, true);
  return { id, name: data.name };
}

export function registerCustomGamesRoutes(app: Hono<{ Bindings: AppBindings }>) {
  registerGameUploadSessionRoutes(app);
  registerGameVersionRoutes(app, { findGame });
  registerCustomGameIntegrityRoutes(app, integrityDependencies);
  app.get("/panel-api/custom-games", async c => {
    await requireAdminSession(c);
    const rows = await c.env.merlin_db.prepare("SELECT * FROM custom_games WHERE deleted_at IS NULL ORDER BY created_at DESC").all<GameRow>();
    const games = await mapConcurrent(rows.results, 4, async row => ({ ...mapGame(row),
      ...(row.pending_archive_key ? { pendingPackage: await pendingGameStatus(c, row) } : {}),
      ...await portReleaseStatus(c.env, metadataFromRow(row)) }));
    return c.json({ success: true, games });
  });

  app.post("/panel-api/custom-games/upload/initiate", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ gameId?: string; filename?: string; sizeBytes?: number; packageType?: "zip" | "folder" }>();
    const gameId = validGameId(body.gameId);
    const size = Number(body.sizeBytes);
    const packageType = body.packageType || "zip";
    const valid = packageType === "zip"
      ? /\.zip$/i.test(String(body.filename || "")) && size <= MAX_ARCHIVE_SIZE
      : packageType === "folder" && size <= MAX_GAME_FILE_SIZE;
    if (!valid || !Number.isSafeInteger(size) || size < 1) {
      fail(packageType === "zip" ? "Selecione um ZIP de até 100 GiB." : "Arquivo do jogo inválido ou acima de 30 GiB.");
    }
    const key = packageType === "zip" ? `${gameId}/archives/${crypto.randomUUID()}.zip` : `${gameId}/files/${crypto.randomUUID()}`;
    const upload = await c.env.CUSTOM_GAMES.createMultipartUpload(key, {
      httpMetadata: { contentType: packageType === "zip" ? "application/zip" : "application/octet-stream", cacheControl: "private, no-store" },
    });
    return c.json({ success: true, key, uploadId: upload.uploadId, partSize: PART_SIZE, packageType });
  });

  app.post("/panel-api/custom-games/upload/file", async c => {
    // Every folder can contain thousands of files. Validate the session on
    // each request without rewriting its D1 row for every individual file.
    await requireAdminSession(c, { mutate: true, touch: false });
    const size = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_DIRECT_FILE_SIZE || !c.req.raw.body) {
      fail("Arquivo direto inválido. Use multipart para arquivos acima de 32 MB.");
    }
    const key = validGameFileKey(c.req.query("key"));
    if (c.req.header("x-upload-retry") === "1") {
      // A successful PUT can lose its HTTP response. Only retries need a HEAD.
      const existing = await c.env.CUSTOM_GAMES.head(key);
      if (existing) {
        if (existing.size !== size) fail("A chave de upload já foi usada para outro tamanho.", 409);
        return c.json({ success: true, key, sizeBytes: existing.size, etag: existing.etag });
      }
    }
    const object = await c.env.CUSTOM_GAMES.put(key, c.req.raw.body, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
    });
    if (!object) fail("A chave de upload já foi usada. Gere outra e tente novamente.", 409);
    if (object.size !== size) {
      await c.env.CUSTOM_GAMES.delete(key);
      fail("O tamanho do arquivo enviado não confere.", 409);
    }
    return c.json({ success: true, key, sizeBytes: object.size, etag: object.etag });
  });

  app.post("/panel-api/custom-games/upload/part", async c => {
    await requireAdminSession(c, { mutate: true, touch: false });
    const key = String(c.req.query("key") || "");
    if (!ARCHIVE_KEY_PATTERN.test(key) && !GAME_FILE_KEY_PATTERN.test(key)) fail("Arquivo de upload inválido.");
    const uploadId = String(c.req.query("uploadId") || "");
    const partNumber = Number(c.req.query("partNumber"));
    const contentLength = Number(c.req.header("content-length"));
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_ARCHIVE_PARTS ||
        !Number.isInteger(contentLength) || contentLength < 1 || contentLength > PART_SIZE) fail("Parte de upload inválida.");
    if (!c.req.raw.body) fail("Parte vazia.");
    const upload = c.env.CUSTOM_GAMES.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, c.req.raw.body);
    return c.json({ success: true, partNumber: part.partNumber, etag: part.etag });
  });

  app.post("/panel-api/custom-games/upload/complete", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ key?: string; uploadId?: string; parts?: { partNumber: number; etag: string }[]; sizeBytes?: number }>();
    const key = String(body.key || "");
    const isArchive = ARCHIVE_KEY_PATTERN.test(key);
    if (!isArchive && !GAME_FILE_KEY_PATTERN.test(key)) fail("Arquivo de upload inválido.");
    const sizeBytes = Number(body.sizeBytes);
    const parts = body.parts || [];
    if (!body.uploadId || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > (isArchive ? MAX_ARCHIVE_SIZE : MAX_GAME_FILE_SIZE) ||
        !Array.isArray(parts) || parts.length !== Math.ceil(sizeBytes / PART_SIZE) ||
        parts.some((part, index) => part.partNumber !== index + 1 || typeof part.etag !== "string" ||
          !/^[A-Za-z0-9"_-]{1,128}$/.test(part.etag))) {
      fail("Partes do arquivo inválidas.");
    }
    const object = await completeGameMultipart(c.env.CUSTOM_GAMES, key, body.uploadId, parts, sizeBytes);
    if (isArchive) {
      const gameId = key.split("/")[0]!;
      if (GAME_ID_PATTERN.test(gameId)) {
        await enqueueGameIntegrity(c, { id: gameId, archive_key: key, archive_size: object.size,
          package_type: "zip" }, integrityDependencies);
      }
    }
    return c.json({ success: true, key, sizeBytes, etag: object.etag });
  });

  app.get("/panel-api/custom-games/upload/indexing", async c => {
    await requireAdminSession(c);
    const gameId = validGameId(c.req.query("gameId"));
    const key = String(c.req.query("archiveKey") || "");
    if (!ARCHIVE_KEY_PATTERN.test(key) || !key.startsWith(`${gameId}/`)) fail("ZIP inválido.");
    const record = await readJob(c.env, await integrityJobId(gameId, key));
    if (!record || record.job.archiveKey !== key) fail("Indexação não encontrada.", 404);
    return c.json({ success: true, status: record.job.status, phase: record.job.phase,
      processedBytes: record.job.processedBytes, totalBytes: record.job.totalBytes,
      processedFiles: record.job.processedFiles, totalFiles: record.job.totalFiles,
      error: record.job.status === "failed" ? record.job.error : undefined });
  });

  app.post("/panel-api/custom-games/upload/abort", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ key?: string; uploadId?: string }>();
    const key = String(body.key || "");
    if (!ARCHIVE_KEY_PATTERN.test(key) && !GAME_FILE_KEY_PATTERN.test(key)) fail("Arquivo de upload inválido.");
    if (!body.uploadId) fail("Upload inválido.");
    await c.env.CUSTOM_GAMES.resumeMultipartUpload(key, body.uploadId).abort();
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games/upload/folder/complete", async c => {
    const admin = await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ gameId?: string; manifestId?: string; sessionId?: string; files?: { path?: string; key?: string; sizeBytes?: number; etag?: string; sha256?: string }[];
      bundles?: { key?: string; sizeBytes?: number; sha256?: string; files?: { path?: string; sizeBytes?: number; sha256?: string }[] }[] }>();
    const gameId = validGameId(body.gameId);
    const manifestId = String(body.manifestId || crypto.randomUUID());
    if (!GAME_ID_PATTERN.test(manifestId)) fail("Identificador do pacote inválido.");
    const files = body.files;
    const bundles = body.bundles || [];
    if (!Array.isArray(files) || !Array.isArray(bundles) || bundles.length > MAX_GAME_BUNDLES ||
        files.length + bundles.reduce((sum, bundle) => sum + (Array.isArray(bundle?.files) ? bundle.files.length : 0), 0) < 1 ||
        files.length + bundles.reduce((sum, bundle) => sum + (Array.isArray(bundle?.files) ? bundle.files.length : 0), 0) > MAX_GAME_FILES) fail("Quantidade de arquivos inválida.");
    const paths = new Set<string>();
    const objectKeys = new Set<string>();
    let totalSizeBytes = 0;
    const validated = files.map(file => {
      const relativePath = validateGameFilePath(file.path);
      const key = validGameFileKey(file.key);
      if (!key.startsWith(`${gameId}/files/`)) fail("Arquivo pertence a outro jogo.");
      if (objectKeys.has(key)) fail("A pasta contém um arquivo duplicado.");
      objectKeys.add(key);
      const sizeBytes = Number(file.sizeBytes);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_GAME_FILE_SIZE) fail("Tamanho de arquivo inválido.");
      const sha256 = validateSha256(file.sha256);
      if (sizeBytes === 0 && sha256 !== EMPTY_SHA256) fail("Hash do arquivo vazio inválido.");
      const normalized = relativePath.toLocaleLowerCase("en-US");
      if (paths.has(normalized)) fail("A pasta contém caminhos duplicados.");
      paths.add(normalized);
      totalSizeBytes += sizeBytes;
      return { id: key.slice(key.lastIndexOf("/") + 1), path: relativePath, key, sizeBytes, sha256 };
    });
    const validatedBundles = bundles.map(bundle => {
      if (!bundle || typeof bundle !== "object") fail("Pacote de arquivos inválido.");
      const key = validGameFileKey(bundle.key);
      if (!key.startsWith(`${gameId}/files/`) || objectKeys.has(key)) fail("Pacote duplicado ou de outro jogo.");
      objectKeys.add(key);
      const sizeBytes = Number(bundle.sizeBytes);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_NEW_BUNDLE_SIZE ||
          !Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > 3000) fail("Pacote de arquivos inválido.");
      const members = bundle.files.map(member => {
        const path = validateGameFilePath(member.path);
        const memberSize = Number(member.sizeBytes);
        const sha256 = validateSha256(member.sha256);
        if (!Number.isSafeInteger(memberSize) || memberSize < 0 || memberSize > MAX_BUNDLE_MEMBER_SIZE ||
            (memberSize === 0 && sha256 !== EMPTY_SHA256)) fail("Arquivo do pacote inválido.");
        const normalized = path.toLocaleLowerCase("en-US");
        if (paths.has(normalized)) fail("A pasta contém caminhos duplicados.");
        paths.add(normalized);
        totalSizeBytes += memberSize;
        return { path, sizeBytes: memberSize, sha256 };
      });
      return { id: key.slice(-36), key, sizeBytes, sha256: validateSha256(bundle.sha256), files: members };
    });
    for (const relativePath of paths) {
      const parts = relativePath.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (paths.has(parts.slice(0, index).join("/"))) fail("A pasta contém conflito entre arquivo e pasta.");
      }
    }
    if (totalSizeBytes < 1 || totalSizeBytes > MAX_GAME_SIZE) fail("A pasta precisa ter conteúdo e não pode ultrapassar 200 GiB.");
    const objects = [...validated, ...validatedBundles];
    const heads = await inspectFolderObjects(c.env.CUSTOM_GAMES, gameId, objects);
    if (heads.some((head, index) => objects[index]!.sizeBytes !== 0 && (!head || head.size !== objects[index]!.sizeBytes))) {
      fail("Um ou mais arquivos enviados estão incompletos.", 409);
    }
    const session = body.sessionId ? await beginGameUploadFinalization(c, body.sessionId,
      admin.session.admin_user_id, gameId, manifestId, objects) : null;
    const manifest: FolderManifest = {
      version: 3,
      files: validated.map((file, index) => ({ ...file, etag: heads[index]?.etag })),
      bundles: validatedBundles.map((bundle, index) => ({ ...bundle, etag: heads[validated.length + index]?.etag })),
      totalSizeBytes,
    };
    const key = `${gameId}/manifests/${manifestId}.json`;
    await putImmutableFolderManifest(c.env, key, manifest);
    if (session) await finishGameUploadFinalization(c, session, key);
    return c.json({ success: true, key, sizeBytes: totalSizeBytes, fileCount: validated.length, packageType: "folder" }, 201);
  });

  app.post("/panel-api/custom-games/upload/discard", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ key?: string }>();
    const key = String(body.key || "");
    if (!ARCHIVE_KEY_PATTERN.test(key) && !MANIFEST_KEY_PATTERN.test(key) && !GAME_FILE_KEY_PATTERN.test(key)) fail("Pacote inválido.");
    const used = await c.env.merlin_db.prepare("SELECT id FROM custom_games WHERE archive_key=? LIMIT 1").bind(key).first();
    if (used) fail("Este ZIP já está vinculado a um jogo.", 409);
    const retained = await c.env.merlin_db.prepare("SELECT archive_key FROM custom_game_versions WHERE archive_key=? AND status!='deleted' LIMIT 1")
      .bind(key).first();
    if (retained) fail("Esta versão está reservada para downloads. A limpeza será feita automaticamente.", 409);
    if (GAME_FILE_KEY_PATTERN.test(key) && (await referencedGameFileKeys(c.env, [key])).has(key)) {
      fail("Este arquivo ainda pertence a um jogo ou versão reservada para download.", 409);
    }
    if (ARCHIVE_KEY_PATTERN.test(key) && GAME_ID_PATTERN.test(key.slice(0, 36))) {
      const record = await readJob(c.env, await integrityJobId(key.slice(0, 36), key));
      if (record && ["queued", "processing"].includes(record.job.status)) {
        const cancelled = { ...record.job, status: "cancelled" as const, phase: "cancelled" as const,
          updatedAt: new Date().toISOString() };
        delete cancelled.leaseToken; delete cancelled.leaseExpiresAt;
        if (!await writeJob(c.env, cancelled, record.etag)) {
          fail("A indexação mudou durante o descarte. Tente novamente.", 409);
        }
      }
    }
    if (MANIFEST_KEY_PATTERN.test(key)) await deletePackage(c, "folder", key);
    else await c.env.CUSTOM_GAMES.delete(key);
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games/stage-zip", async c => {
    await requireAdminSession(c, { mutate: true });
    const id = validGameId((await c.req.raw.clone().formData()).get("gameId"));
    const prior = await findGame(c, id);
    if (prior?.deleted_at) fail("Este jogo foi removido.", 404);
    const previous = prior ? pendingGameData(prior) : null;
    const formPrior = prior && previous ? { ...prior, image_key: previous.imageKey } : prior;
    const data = await readGameForm(c, id, formPrior, { allowPendingZip: true });
    if (data.packageType !== "zip" || !data.archiveKey.startsWith(`${id}/archives/`)) {
      fail("Selecione um ZIP enviado para este jogo.");
    }
    if (prior?.published && data.archiveKey === prior.archive_key) {
      fail("Este ZIP já está publicado. Envie uma versão nova para preparar uma atualização.", 409);
    }
    const source = await c.env.CUSTOM_GAMES.head(data.archiveKey);
    if (!source || source.size !== data.archiveSize) fail("O ZIP enviado não está disponível.", 409);
    await enqueueGameIntegrity(c, { id, archive_key: data.archiveKey, archive_size: data.archiveSize,
      package_type: "zip" }, integrityDependencies);
    if (prior) {
      const update = await c.env.merlin_db.prepare(`UPDATE custom_games SET pending_archive_key=?,pending_source_etag=?,
        pending_data_json=?,pending_base_archive_key=?,pending_created_at=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND archive_key=? AND pending_archive_key IS ?`)
        .bind(data.archiveKey, source.etag, JSON.stringify(data), prior.archive_key, new Date().toISOString(),
          id, prior.archive_key, prior.pending_archive_key || null).run();
      if (!update.meta.changes) fail("Este jogo mudou enquanto você editava. Atualize e tente novamente.", 409);
    } else {
      await c.env.merlin_db.prepare(`INSERT INTO custom_games
        (id,name,install_name,admin_note,admin_notes_json,image_key,image_position_x,image_position_y,image_zoom,
         archive_key,archive_size,package_type,executable_path,published,origin,repository_url,discord_url,
         protected_paths_json,version_label,tracked_release_tag,pending_archive_key,pending_source_etag,
         pending_data_json,pending_base_archive_key,pending_created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, data.name, `draft-${id}`, data.note, data.notes, data.imageKey, data.imagePositionX,
          data.imagePositionY, data.imageZoom, `draft/${id}`, 0, "zip", data.executablePath, 0,
          data.origin, data.repositoryUrl, data.discordUrl, JSON.stringify(data.protectedPaths),
          data.versionLabel, data.trackedReleaseTag, data.archiveKey, source.etag, JSON.stringify(data),
          `draft/${id}`, new Date().toISOString()).run();
    }
    if (previous?.archiveKey && previous.archiveKey !== data.archiveKey) {
      await discardStagedZip(c, id, previous.archiveKey, prior?.archive_key || "");
    }
    if (previous?.imageKey && previous.imageKey !== data.imageKey && previous.imageKey !== prior?.image_key) {
      await c.env.CUSTOM_GAMES.delete(previous.imageKey);
    }
    return c.json({ success: true, id, indexStatus: "queued" }, prior ? 200 : 201);
  });

  app.post("/panel-api/custom-games/publish-ready", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ gameIds?: string[] }>();
    if (!Array.isArray(body.gameIds) || body.gameIds.length < 1 || body.gameIds.length > 50 ||
        body.gameIds.some(id => !GAME_ID_PATTERN.test(String(id))) || new Set(body.gameIds).size !== body.gameIds.length) {
      fail("Selecione até 50 jogos prontos para publicar.");
    }
    const published: { id: string; name: string }[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of body.gameIds) {
      try { published.push(await publishStagedZip(c, id)); }
      catch (error) { failed.push({ id, error: error instanceof Error ? error.message : "Falha ao publicar." }); }
    }
    return c.json({ success: failed.length === 0, published, failed });
  });

  app.post("/panel-api/custom-games/:id/publish-ready", async c => {
    await requireAdminSession(c, { mutate: true });
    return c.json({ success: true, published: await publishStagedZip(c, validGameId(c.req.param("id"))) });
  });

  app.post("/panel-api/custom-games/:id/discard-staged-zip", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, validGameId(c.req.param("id")));
    if (!prior || prior.deleted_at || !prior.pending_archive_key) fail("ZIP pendente não encontrado.", 404);
    const staged = pendingGameData(prior);
    const result = await c.env.merlin_db.prepare(`UPDATE custom_games SET pending_archive_key=NULL,
      pending_source_etag=NULL,pending_data_json=NULL,pending_base_archive_key=NULL,pending_created_at=NULL,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND pending_archive_key=?`)
      .bind(prior.id, prior.pending_archive_key).run();
    if (!result.meta.changes) fail("O ZIP pendente mudou. Atualize e tente novamente.", 409);
    await discardStagedZip(c, prior.id, prior.pending_archive_key, prior.archive_key);
    if (staged?.imageKey && staged.imageKey !== prior.image_key) await c.env.CUSTOM_GAMES.delete(staged.imageKey);
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games", async c => {
    await requireAdminSession(c, { mutate: true });
    const id = validGameId((await c.req.raw.clone().formData()).get("gameId"));
    const data = await readGameForm(c, id);
    const snapshot = packageSnapshot(id, data);
    const insert = c.env.merlin_db.prepare(`INSERT INTO custom_games
      (id,name,install_name,admin_note,admin_notes_json,image_key,image_position_x,image_position_y,image_zoom,archive_key,archive_size,package_type,executable_path,published,
       origin,repository_url,discord_url,protected_paths_json,version_label,tracked_release_tag)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, data.name, data.installName, data.note, data.notes, data.imageKey,
      data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey, data.archiveSize,
      data.packageType, data.executablePath, data.published, data.origin, data.repositoryUrl, data.discordUrl,
      JSON.stringify(data.protectedPaths), data.versionLabel, data.trackedReleaseTag);
    await publishBatch(c, [insert, ...(!data.archiveKey.startsWith("draft/")
      ? [gameVersionInsertStatement(c.env, snapshot)] : [])]);
    if (!data.archiveKey.startsWith("draft/")) await queuePublishedIntegrity(c, snapshot);
    return c.json({ success: true, id }, 201);
  });

  app.put("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior || prior.deleted_at) fail("Jogo não encontrado.", 404);
    if (prior.pending_archive_key) fail("Este jogo tem um ZIP pendente. Edite ou publique esse pacote primeiro.", 409);
    const data = await readGameForm(c, prior.id, prior);
    await applyGameUpdate(c, prior, data);
    return c.json({ success: true, id: prior.id });
  });

  app.delete("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior || prior.deleted_at) fail("Jogo não encontrado.", 404);
    if (!prior.archive_key.startsWith("draft/")) await ensureGameVersion(c.env, mapGame(prior));
    const now = new Date().toISOString();
    await c.env.merlin_db.batch([
      c.env.merlin_db.prepare("UPDATE custom_games SET published=0,deleted_at=?,install_name=? WHERE id=?")
        .bind(now, `deleted-${prior.id}`, prior.id),
      c.env.merlin_db.prepare(`UPDATE custom_game_versions SET status='retired',legacy_hold=0,retired_at=?,delete_after=?
        WHERE game_id=? AND status IN ('active','retired')`).bind(now, new Date(Date.now() + 86400_000).toISOString(), prior.id),
    ]);
    if (prior.image_key) await c.env.CUSTOM_GAMES.delete(prior.image_key);
    if (prior.pending_archive_key) {
      const staged = pendingGameData(prior);
      await discardStagedZip(c, prior.id, prior.pending_archive_key, prior.archive_key);
      if (staged?.imageKey && staged.imageKey !== prior.image_key) await c.env.CUSTOM_GAMES.delete(staged.imageKey);
    }
    if (!prior.archive_key.startsWith("draft/")) await queuePublishedIntegrity(c, mapGame(prior));
    return c.json({ success: true });
  });

  app.get("/api/custom-games", async c => {
    await requireGoldLauncherLicense(c);
    const rows = await c.env.merlin_db.prepare("SELECT * FROM custom_games WHERE published=1 AND deleted_at IS NULL ORDER BY name COLLATE NOCASE")
      .all<GameRow>();
    const modern = c.req.header("x-merlin-custom-games-protocol") === "2";
    const games = modern ? rows.results.map(mapGame) : await mapConcurrent(rows.results, 6,
      async row => getLegacyGamePackage(c.env, mapGame(row)));
    return c.json({ success: true, games });
  });

  app.get("/api/custom-games/:id/image", async c => {
    const game = await findGame(c, c.req.param("id"));
    if (!game || !game.published) fail("Imagem não encontrada.", 404);
    const object = await c.env.CUSTOM_GAMES.get(game.image_key);
    if (!object) fail("Imagem não encontrada.", 404);
    return new Response(object.body, { status: 200, headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=86400",
    } });
  });

  app.get("/panel-api/custom-games/:id/image", async c => {
    await requireAdminSession(c);
    const game = await findGame(c, c.req.param("id"));
    if (!game) fail("Imagem não encontrada.", 404);
    const key = c.req.query("pending") === "1" ? pendingGameData(game)?.imageKey : game.image_key;
    if (!key) fail("Imagem não encontrada.", 404);
    const object = await c.env.CUSTOM_GAMES.get(key);
    if (!object) fail("Imagem não encontrada.", 404);
    return new Response(object.body, { status: 200, headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, no-store",
    } });
  });

  app.get("/api/custom-games/:id/manifest", async c => {
    const license = await requireGoldLauncherLicense(c);
    let game = await findGame(c, c.req.param("id"));
    if (game) game = await resolveGamePackage(c, game, license);
    if (!game || (!game.published && !c.req.query("downloadSessionId")) || (game.package_type || "zip") !== "folder") fail("Manifesto não encontrado.", 404);
    const manifest = await loadFolderManifest(c, game.archive_key);
    if (manifest.totalSizeBytes !== game.archive_size) fail("Manifesto não corresponde ao catálogo.", 409);
    return c.json({ success: true, gameId: game.id, archiveKey: game.archive_key, totalSizeBytes: manifest.totalSizeBytes,
      files: manifest.files.map(file => ({ id: file.id, path: file.path, sizeBytes: file.sizeBytes, etag: file.etag,
        ...(file.sha256 ? { sha256: file.sha256 } : {}) })),
      ...(manifest.bundles ? { bundles: manifest.bundles.map(bundle => ({ id: bundle.id, sizeBytes: bundle.sizeBytes,
        sha256: bundle.sha256, etag: bundle.etag, files: bundle.files })) } : {}) }, 200, {
      "cache-control": "private, no-store",
    });
  });

  app.get("/api/custom-games/:id/files/:fileId", async c => {
    const license = await requireGoldLauncherLicense(c);
    let game = await findGame(c, c.req.param("id"));
    if (game) game = await resolveGamePackage(c, game, license);
    const fileId = c.req.param("fileId");
    if (!game || (!game.published && !c.req.query("downloadSessionId")) || (game.package_type || "zip") !== "folder" || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      fail("Arquivo não encontrado.", 404);
    }
    const manifest = await loadFolderManifest(c, game.archive_key);
    const file = [...manifest.files, ...(manifest.bundles || [])].find(entry => entry.id.toLowerCase() === fileId.toLowerCase());
    if (!file) fail("Arquivo não encontrado.", 404);
    const match = /^bytes=(\d+)-(\d+)$/.exec(c.req.header("range") || "");
    if (!match) return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.sizeBytes}` } });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
        end >= file.sizeBytes || end - start + 1 > MAX_FOLDER_RANGE_SIZE) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.sizeBytes}` } });
    }
    const object = await c.env.CUSTOM_GAMES.get(file.key, { range: { offset: start, length: end - start + 1 } });
    if (!object) fail("Arquivo do jogo não encontrado.", 404);
    return new Response(object.body, { status: 206, headers: {
      "content-type": "application/octet-stream", "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${file.sizeBytes}`, "accept-ranges": "bytes",
      etag: object.etag,
      "cache-control": "private, no-store",
    } });
  });

  app.get("/api/custom-games/:id/entries/:entryIndex", async c => {
    const license = await requireGoldLauncherLicense(c);
    const current = await findGame(c, c.req.param("id"));
    if (!current) fail("Jogo não encontrado.", 404);
    const game = await resolveGamePackage(c, current, license, { requireSession: true });
    if (game.packageType !== "zip" || !/^\d{1,6}$/.test(c.req.param("entryIndex"))) fail("Arquivo não encontrado.", 404);
    const manifest = await getIntegrityManifest(c, game, integrityDependencies);
    if (!manifest) throw Object.assign(new HTTPException(409, { message: "O ZIP aguarda indexação para atualizar arquivos individualmente." }), { code: "integrity_index_pending" });
    const entry = manifest.files[Number(c.req.param("entryIndex"))];
    const zip = entry?.zip;
    if (!zip || ![0, 8, 9].includes(zip.method) || !Number.isSafeInteger(zip.offset) || zip.offset < 0 ||
        !Number.isSafeInteger(zip.compressedSize) || zip.compressedSize < 0 || zip.offset + zip.compressedSize > game.archiveSize)
      fail("Arquivo do índice ZIP inválido.", 409);
    const match = /^bytes=(\d+)-(\d+)$/.exec(c.req.header("range") || "");
    const start = Number(match?.[1]); const end = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
        end >= zip.compressedSize || end - start + 1 > MAX_RANGE_SIZE)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${zip.compressedSize}` } });
    // Serve only the indexed compressed payload; inflate and SHA-256 happen in the launcher.
    const object = await c.env.CUSTOM_GAMES.get(game.archiveKey, { range: { offset: zip.offset + start, length: end - start + 1 },
      ...(manifest.sourceEtag ? { onlyIf: { etagMatches: manifest.sourceEtag } } : {}) });
    if (!object || !("body" in object)) throw Object.assign(new HTTPException(409, { message: "O ZIP mudou desde a indexação." }), { code: "package_changed" });
    return new Response(object.body, { status: 206, headers: {
      "content-type": "application/octet-stream", "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${zip.compressedSize}`, "accept-ranges": "bytes",
      etag: object.etag, "cache-control": "private, no-store",
    } });
  });

  app.get("/api/custom-games/:id/archive", async c => {
    const license = await requireGoldLauncherLicense(c);
    let game = await findGame(c, c.req.param("id"));
    if (game) game = await resolveGamePackage(c, game, license);
    if (!game || (!game.published && !c.req.query("downloadSessionId")) || (game.package_type || "zip") !== "zip") fail("Jogo não encontrado.", 404);
    const match = /^bytes=(\d+)-(\d+)$/.exec(c.req.header("range") || "");
    if (!match) return new Response(null, { status: 416, headers: { "content-range": `bytes */${game.archive_size}` } });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
        end >= game.archive_size || end - start + 1 > MAX_RANGE_SIZE) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${game.archive_size}` } });
    }
    const object = await c.env.CUSTOM_GAMES.get(game.archive_key, { range: { offset: start, length: end - start + 1 } });
    if (!object) fail("ZIP não encontrado.", 404);
    return new Response(object.body, { status: 206, headers: {
      "content-type": "application/zip",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${game.archive_size}`,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
    } });
  });
}
