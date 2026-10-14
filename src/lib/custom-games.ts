import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { requireLauncherLicense } from "./launcher-auth";
import { beginGameUploadFinalization, completeGameMultipart, finishGameUploadFinalization,
  registerGameUploadSessionRoutes } from "./custom-game-upload-sessions";

const PART_SIZE = 64 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 30 * 1024 * 1024 * 1024;
const MAX_GAME_SIZE = 200 * 1024 * 1024 * 1024;
const MAX_GAME_FILE_SIZE = 30 * 1024 * 1024 * 1024;
const MAX_GAME_FILES = 20000;
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

type GameRow = {
  id: string; name: string; install_name: string; admin_note: string; admin_notes_json: string;
  image_key: string; image_position_x: number; image_position_y: number; image_zoom: number;
  archive_key: string; archive_size: number; executable_path: string | null;
  package_type?: "zip" | "folder";
  published: number; created_at: string; updated_at: string;
};

type FolderFile = { id: string; path: string; key: string; sizeBytes: number; etag?: string; sha256?: string };
type BundleMember = { path: string; sizeBytes: number; sha256: string };
type FolderBundle = { id: string; key: string; sizeBytes: number; sha256: string; etag?: string; files: BundleMember[] };
type FolderManifest = { version: 1 | 2 | 3; files: FolderFile[]; bundles?: FolderBundle[]; totalSizeBytes: number };

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
    const keys = [...(Array.isArray(manifest.files) ? manifest.files : []),
      ...(Array.isArray(manifest.bundles) ? manifest.bundles : [])]
      .filter(file => typeof file?.key === "string" && GAME_FILE_KEY_PATTERN.test(file.key))
      .map(file => file.key);
    const unique = [...new Set(keys)];
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

function readNumber(value: string | File | null, fallback: number, min: number, max: number): number {
  const number = value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail("Enquadramento de imagem inválido.");
  return number;
}

export async function readGameForm(c: AppContext, id: string, prior?: GameRow | null) {
  const form = await c.req.formData();
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
  let archiveSize = 0;
  if (suppliedKey) {
    if (packageType === "zip") {
      const archive = await c.env.CUSTOM_GAMES.head(archiveKey);
      if (!archive || !archive.size || archive.size > MAX_ARCHIVE_SIZE) fail("Envie um ZIP válido antes de salvar.");
      archiveSize = archive.size;
    } else {
      const manifest = await loadFolderManifest(c, archiveKey);
      archiveSize = manifest.totalSizeBytes;
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
    name, installName, note, notes: JSON.stringify(notes), executablePath, packageType, archiveKey, archiveSize, imageKey,
    imagePositionX, imagePositionY, imageZoom,
    published: published ? 1 : 0,
  };
}

export function registerCustomGamesRoutes(app: Hono<{ Bindings: AppBindings }>) {
  registerGameUploadSessionRoutes(app);
  app.get("/panel-api/custom-games", async c => {
    await requireAdminSession(c);
    const rows = await c.env.merlin_db.prepare("SELECT * FROM custom_games ORDER BY created_at DESC").all<GameRow>();
    return c.json({ success: true, games: rows.results.map(mapGame) });
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
      fail(packageType === "zip" ? "Selecione um ZIP de até 30 GB." : "Arquivo do jogo inválido ou acima de 30 GB.");
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
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 512 ||
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
    return c.json({ success: true, key, sizeBytes, etag: object.etag });
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
    await c.env.CUSTOM_GAMES.put(key, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
    });
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
    if (MANIFEST_KEY_PATTERN.test(key)) await deletePackage(c, "folder", key);
    else await c.env.CUSTOM_GAMES.delete(key);
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games", async c => {
    await requireAdminSession(c, { mutate: true });
    const id = validGameId((await c.req.raw.clone().formData()).get("gameId"));
    const data = await readGameForm(c, id);
    await c.env.merlin_db.prepare(`INSERT INTO custom_games
      (id,name,install_name,admin_note,admin_notes_json,image_key,image_position_x,image_position_y,image_zoom,archive_key,archive_size,package_type,executable_path,published)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, data.name, data.installName, data.note, data.notes, data.imageKey,
      data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey, data.archiveSize,
      data.packageType, data.executablePath, data.published).run();
    return c.json({ success: true, id }, 201);
  });

  app.put("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior) fail("Jogo não encontrado.", 404);
    const data = await readGameForm(c, prior.id, prior);
    await c.env.merlin_db.prepare(`UPDATE custom_games SET name=?,install_name=?,admin_note=?,admin_notes_json=?,image_key=?,
      image_position_x=?,image_position_y=?,image_zoom=?,archive_key=?,archive_size=?,package_type=?,executable_path=?,
      published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(data.name, data.installName, data.note, data.notes,
      data.imageKey, data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey,
      data.archiveSize, data.packageType, data.executablePath, data.published, prior.id).run();
    if (prior.image_key && prior.image_key !== data.imageKey) await c.env.CUSTOM_GAMES.delete(prior.image_key);
    if (prior.archive_key !== data.archiveKey || (prior.package_type || "zip") !== data.packageType) {
      await deletePackage(c, prior.package_type || "zip", prior.archive_key);
    }
    return c.json({ success: true, id: prior.id });
  });

  app.delete("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior) fail("Jogo não encontrado.", 404);
    await c.env.merlin_db.prepare("DELETE FROM custom_games WHERE id=?").bind(prior.id).run();
    await Promise.all([prior.image_key ? c.env.CUSTOM_GAMES.delete(prior.image_key) : Promise.resolve(), deletePackage(c, prior.package_type || "zip", prior.archive_key)]);
    return c.json({ success: true });
  });

  app.get("/api/custom-games", async c => {
    await requireLauncherLicense(c);
    const rows = await c.env.merlin_db.prepare("SELECT * FROM custom_games WHERE published=1 ORDER BY name COLLATE NOCASE")
      .all<GameRow>();
    return c.json({ success: true, games: rows.results.map(mapGame) });
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
    const object = await c.env.CUSTOM_GAMES.get(game.image_key);
    if (!object) fail("Imagem não encontrada.", 404);
    return new Response(object.body, { status: 200, headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, no-store",
    } });
  });

  app.get("/api/custom-games/:id/manifest", async c => {
    await requireLauncherLicense(c);
    const game = await findGame(c, c.req.param("id"));
    if (!game || !game.published || (game.package_type || "zip") !== "folder") fail("Manifesto não encontrado.", 404);
    const manifest = await loadFolderManifest(c, game.archive_key);
    if (manifest.totalSizeBytes !== game.archive_size) fail("Manifesto não corresponde ao catálogo.", 409);
    return c.json({ success: true, gameId: game.id, totalSizeBytes: manifest.totalSizeBytes,
      files: manifest.files.map(file => ({ id: file.id, path: file.path, sizeBytes: file.sizeBytes, etag: file.etag,
        ...(file.sha256 ? { sha256: file.sha256 } : {}) })),
      ...(manifest.bundles ? { bundles: manifest.bundles.map(bundle => ({ id: bundle.id, sizeBytes: bundle.sizeBytes,
        sha256: bundle.sha256, etag: bundle.etag, files: bundle.files })) } : {}) }, 200, {
      "cache-control": "private, no-store",
    });
  });

  app.get("/api/custom-games/:id/files/:fileId", async c => {
    await requireLauncherLicense(c);
    const game = await findGame(c, c.req.param("id"));
    const fileId = c.req.param("fileId");
    if (!game || !game.published || (game.package_type || "zip") !== "folder" || !/^[0-9a-f-]{36}$/i.test(fileId)) {
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

  app.get("/api/custom-games/:id/archive", async c => {
    await requireLauncherLicense(c);
    const game = await findGame(c, c.req.param("id"));
    if (!game || !game.published || (game.package_type || "zip") !== "zip") fail("Jogo não encontrado.", 404);
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
