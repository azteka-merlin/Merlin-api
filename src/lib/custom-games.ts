import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";
import { requireAdminSession } from "./admin-security";
import { requireLauncherLicense } from "./launcher-auth";

const PART_SIZE = 64 * 1024 * 1024;
const MAX_ARCHIVE_SIZE = 30 * 1024 * 1024 * 1024;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RANGE_SIZE = 64 * 1024 * 1024;
const ARCHIVE_KEY_PATTERN = /^archives\/[0-9a-f-]{36}\.zip$/;

type GameRow = {
  id: string; name: string; install_name: string; admin_note: string; admin_notes_json: string;
  image_key: string; image_position_x: number; image_position_y: number; image_zoom: number;
  archive_key: string; archive_size: number; executable_path: string | null;
  published: number; created_at: string; updated_at: string;
};

function fail(message: string, status: 400 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}

function validArchiveKey(value: unknown): string {
  const key = String(value || "");
  if (!ARCHIVE_KEY_PATTERN.test(key)) fail("Arquivo ZIP inválido.");
  return key;
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
    imageUrl: `/api/custom-games/${row.id}/image?v=${encodeURIComponent(row.image_key)}`,
    imageVersion: row.image_key,
    imagePositionX: row.image_position_x, imagePositionY: row.image_position_y, imageZoom: row.image_zoom,
    archiveKey: row.archive_key, archiveSize: row.archive_size,
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

async function readGameForm(c: AppContext, prior?: GameRow | null) {
  const form = await c.req.formData();
  const name = String(form.get("name") || "").trim();
  if (!name || name.length > 120) fail("Informe um nome de até 120 caracteres.");
  const installName = validateInstallName(name);
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
  const archiveKey = validArchiveKey(form.get("archiveKey") || prior?.archive_key);
  const archive = await c.env.CUSTOM_GAMES.head(archiveKey);
  if (!archive || !archive.size || archive.size > MAX_ARCHIVE_SIZE) fail("Envie um ZIP válido antes de salvar.");
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
    imageKey = `images/${crypto.randomUUID()}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
    await c.env.CUSTOM_GAMES.put(imageKey, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=86400" } });
  }
  if (!imageKey) fail("Selecione uma imagem do jogo.");
  return {
    name, installName, note, notes: JSON.stringify(notes), executablePath, archiveKey, archiveSize: archive.size, imageKey,
    imagePositionX, imagePositionY, imageZoom,
    published: form.get("published") === "true" ? 1 : 0,
  };
}

export function registerCustomGamesRoutes(app: Hono<{ Bindings: AppBindings }>) {
  app.get("/panel-api/custom-games", async c => {
    await requireAdminSession(c);
    const rows = await c.env.merlin_db.prepare("SELECT * FROM custom_games ORDER BY created_at DESC").all<GameRow>();
    return c.json({ success: true, games: rows.results.map(mapGame) });
  });

  app.post("/panel-api/custom-games/upload/initiate", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ filename?: string; sizeBytes?: number }>();
    const size = Number(body.sizeBytes);
    if (!/\.zip$/i.test(String(body.filename || "")) || !Number.isSafeInteger(size) || size < 1 || size > MAX_ARCHIVE_SIZE) {
      fail("Selecione um ZIP de até 30 GB.");
    }
    const key = `archives/${crypto.randomUUID()}.zip`;
    const upload = await c.env.CUSTOM_GAMES.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/zip", cacheControl: "private, no-store" },
    });
    return c.json({ success: true, key, uploadId: upload.uploadId, partSize: PART_SIZE });
  });

  app.post("/panel-api/custom-games/upload/part", async c => {
    await requireAdminSession(c, { mutate: true });
    const key = validArchiveKey(c.req.query("key"));
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
    const key = validArchiveKey(body.key);
    const sizeBytes = Number(body.sizeBytes);
    const parts = body.parts || [];
    if (!body.uploadId || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ARCHIVE_SIZE ||
        !Array.isArray(parts) || parts.length !== Math.ceil(sizeBytes / PART_SIZE) ||
        parts.some((part, index) => part.partNumber !== index + 1 || typeof part.etag !== "string" ||
          !/^[A-Za-z0-9"_-]{1,128}$/.test(part.etag))) {
      fail("Partes do ZIP inválidas.");
    }
    await c.env.CUSTOM_GAMES.resumeMultipartUpload(key, body.uploadId).complete(parts);
    const object = await c.env.CUSTOM_GAMES.head(key);
    if (object?.size !== sizeBytes) fail("Tamanho do ZIP não corresponde ao arquivo enviado.", 409);
    return c.json({ success: true, key, sizeBytes });
  });

  app.post("/panel-api/custom-games/upload/abort", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ key?: string; uploadId?: string }>();
    const key = validArchiveKey(body.key);
    if (!body.uploadId) fail("Upload inválido.");
    await c.env.CUSTOM_GAMES.resumeMultipartUpload(key, body.uploadId).abort();
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games/upload/discard", async c => {
    await requireAdminSession(c, { mutate: true });
    const body = await c.req.json<{ key?: string }>();
    const key = validArchiveKey(body.key);
    const used = await c.env.merlin_db.prepare("SELECT id FROM custom_games WHERE archive_key=? LIMIT 1").bind(key).first();
    if (used) fail("Este ZIP já está vinculado a um jogo.", 409);
    await c.env.CUSTOM_GAMES.delete(key);
    return c.json({ success: true });
  });

  app.post("/panel-api/custom-games", async c => {
    await requireAdminSession(c, { mutate: true });
    const data = await readGameForm(c);
    const id = crypto.randomUUID();
    await c.env.merlin_db.prepare(`INSERT INTO custom_games
      (id,name,install_name,admin_note,admin_notes_json,image_key,image_position_x,image_position_y,image_zoom,archive_key,archive_size,executable_path,published)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, data.name, data.installName, data.note, data.notes, data.imageKey,
      data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey, data.archiveSize,
      data.executablePath, data.published).run();
    return c.json({ success: true, id }, 201);
  });

  app.put("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior) fail("Jogo não encontrado.", 404);
    const data = await readGameForm(c, prior);
    await c.env.merlin_db.prepare(`UPDATE custom_games SET name=?,install_name=?,admin_note=?,admin_notes_json=?,image_key=?,
      image_position_x=?,image_position_y=?,image_zoom=?,archive_key=?,archive_size=?,executable_path=?,
      published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(data.name, data.installName, data.note, data.notes,
      data.imageKey, data.imagePositionX, data.imagePositionY, data.imageZoom, data.archiveKey,
      data.archiveSize, data.executablePath, data.published, prior.id).run();
    if (prior.image_key !== data.imageKey) await c.env.CUSTOM_GAMES.delete(prior.image_key);
    if (prior.archive_key !== data.archiveKey) await c.env.CUSTOM_GAMES.delete(prior.archive_key);
    return c.json({ success: true, id: prior.id });
  });

  app.delete("/panel-api/custom-games/:id", async c => {
    await requireAdminSession(c, { mutate: true });
    const prior = await findGame(c, c.req.param("id"));
    if (!prior) fail("Jogo não encontrado.", 404);
    await c.env.merlin_db.prepare("DELETE FROM custom_games WHERE id=?").bind(prior.id).run();
    await Promise.all([c.env.CUSTOM_GAMES.delete(prior.image_key), c.env.CUSTOM_GAMES.delete(prior.archive_key)]);
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

  app.get("/api/custom-games/:id/archive", async c => {
    await requireLauncherLicense(c);
    const game = await findGame(c, c.req.param("id"));
    if (!game || !game.published) fail("Jogo não encontrado.", 404);
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
