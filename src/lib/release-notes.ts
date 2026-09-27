import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const RELEASE_ASSET_PREFIX = "release-notes";
const MAX_RELEASE_ASSET_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_LOCALES = ["ptbr", "en", "es", "fr", "de"] as const;
const SUPPORTED_ICONS = new Set(["home", "steam", "library", "settings", "sparkles", "wrench", "gift", "megaphone"]);

type ReleaseType = "major" | "standard";
type Locale = (typeof SUPPORTED_LOCALES)[number];

type ReleaseRow = {
  id: number;
  version: string;
  release_type: ReleaseType;
  hero_asset_key: string | null;
  hero_asset_path: string | null;
  hero_asset_filename: string | null;
  hero_asset_content_type: string | null;
  hero_asset_size_bytes: number;
  published: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

type LocalizationRow = {
  id: number;
  release_note_id: number;
  locale: Locale;
  title: string;
  subtitle: string;
  summary: string;
  highlights_json: string;
  full_content_json: string;
  created_at: string;
  updated_at: string;
};

export type ReleaseNoteHighlightInput = {
  icon?: string | null;
  title?: string | null;
  description?: string | null;
};

export type ReleaseNoteLocalizationInput = {
  locale?: string | null;
  title?: string | null;
  subtitle?: string | null;
  summary?: string | null;
  highlights?: ReleaseNoteHighlightInput[] | null;
  fullContent?: string[] | null;
};

export type ReleaseNoteInput = {
  version?: string | null;
  type?: string | null;
  published?: boolean | null;
  publishedAt?: string | null;
  removeHeroAsset?: boolean | null;
  localizations?: ReleaseNoteLocalizationInput[] | null;
};

function normalizeId(value: string | number) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "Novidade inválida." });
  return id;
}

function normalizeLocale(value: string | null | undefined): Locale {
  const locale = String(value || "ptbr").trim().toLowerCase().replace("pt-br", "ptbr");
  return SUPPORTED_LOCALES.includes(locale as Locale) ? locale as Locale : "ptbr";
}

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value || "").trim();
  if (!text) throw new HTTPException(400, { message: `Informe ${label}.` });
  if (text.length > maxLength) throw new HTTPException(400, { message: `${label} deve ter no máximo ${maxLength} caracteres.` });
  return text;
}

function normalizeVersion(value: unknown) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new HTTPException(400, { message: "Informe uma versão semântica válida, como 2.0.0." });
  }
  return version;
}

function normalizeDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new HTTPException(400, { message: "Data de publicação inválida." });
  return date.toISOString();
}

function normalizeImage(file: File) {
  const contentType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new HTTPException(400, { message: "Envie uma imagem JPG, PNG ou WebP." });
  if (!file.size || file.size > MAX_RELEASE_ASSET_BYTES) throw new HTTPException(400, { message: "A imagem deve ter até 12 MB." });
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const filename = String(file.name || `release.${extension}`).replace(/[^\w.-]+/g, "-").slice(0, 120) || `release.${extension}`;
  return { contentType, extension, filename };
}

function normalizeLocalization(input: ReleaseNoteLocalizationInput) {
  const locale = normalizeLocale(input.locale);
  const highlights = Array.isArray(input.highlights) ? input.highlights.slice(0, 8).map((item) => ({
    icon: SUPPORTED_ICONS.has(String(item?.icon || "")) ? String(item.icon) : "sparkles",
    title: requiredText(item?.title, "o título do destaque", 120),
    description: requiredText(item?.description, "a descrição do destaque", 360),
  })) : [];
  const fullContent = Array.isArray(input.fullContent)
    ? input.fullContent.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 80)
    : [];
  if (!highlights.length) throw new HTTPException(400, { message: `Adicione ao menos um destaque em ${locale}.` });
  if (!fullContent.length) throw new HTTPException(400, { message: `Adicione o changelog completo em ${locale}.` });
  return {
    locale,
    title: requiredText(input.title, "o título", 180),
    subtitle: requiredText(input.subtitle, "o subtítulo", 260),
    summary: requiredText(input.summary, "o resumo", 600),
    highlights,
    fullContent,
  };
}

function normalizeInput(input: ReleaseNoteInput) {
  const localizations = Array.isArray(input.localizations) ? input.localizations.map(normalizeLocalization) : [];
  const unique = new Map(localizations.map((entry) => [entry.locale, entry]));
  if (!unique.has("ptbr")) throw new HTTPException(400, { message: "A localização pt-BR é obrigatória." });
  return {
    version: normalizeVersion(input.version),
    type: input.type === "standard" ? "standard" as const : "major" as const,
    published: input.published === true,
    publishedAt: normalizeDate(input.publishedAt),
    removeHeroAsset: input.removeHeroAsset === true,
    localizations: [...unique.values()],
  };
}

function parseJsonList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function heroAssetUrl(row: ReleaseRow, audience: "admin" | "launcher") {
  if (row.hero_asset_key) {
    return `${audience === "admin" ? "/panel-api" : "/api"}/release-notes/${row.id}/hero?v=${encodeURIComponent(row.updated_at)}`;
  }
  return row.hero_asset_path || null;
}

function mapLocalization(row: LocalizationRow) {
  return {
    locale: row.locale,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    highlights: parseJsonList(row.highlights_json),
    fullContent: parseJsonList(row.full_content_json),
  };
}

async function releaseRow(c: AppContext, value: string | number) {
  const id = normalizeId(value);
  const row = await c.env.merlin_db.prepare("SELECT * FROM release_notes WHERE id = ? LIMIT 1").bind(id).first<ReleaseRow>();
  if (!row) throw new HTTPException(404, { message: "Novidade não encontrada." });
  return row;
}

async function localizationRows(c: AppContext, releaseId: number) {
  const result = await c.env.merlin_db.prepare("SELECT * FROM release_note_localizations WHERE release_note_id = ? ORDER BY CASE locale WHEN 'ptbr' THEN 0 ELSE 1 END, locale").bind(releaseId).all<LocalizationRow>();
  return result.results || [];
}

async function mapAdminRelease(c: AppContext, row: ReleaseRow) {
  return {
    id: row.id,
    version: row.version,
    type: row.release_type,
    heroAssetUrl: heroAssetUrl(row, "admin"),
    heroAssetFilename: row.hero_asset_filename,
    heroAssetContentType: row.hero_asset_content_type,
    heroAssetSizeBytes: Number(row.hero_asset_size_bytes || 0),
    published: Boolean(row.published),
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    localizations: (await localizationRows(c, row.id)).map(mapLocalization),
  };
}

function pickLocalization(rows: LocalizationRow[], locale: Locale) {
  return rows.find((row) => row.locale === locale) || rows.find((row) => row.locale === "ptbr") || rows[0];
}

async function mapLauncherRelease(c: AppContext, row: ReleaseRow, locale: Locale) {
  const localization = pickLocalization(await localizationRows(c, row.id), locale);
  if (!localization) return null;
  return {
    id: row.id,
    version: row.version,
    type: row.release_type,
    heroAssetUrl: heroAssetUrl(row, "launcher"),
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    ...mapLocalization(localization),
  };
}

export async function listAdminReleaseNotes(c: AppContext) {
  const result = await c.env.merlin_db.prepare("SELECT * FROM release_notes ORDER BY published DESC, COALESCE(published_at, updated_at) DESC, id DESC").all<ReleaseRow>();
  return Promise.all((result.results || []).map((row) => mapAdminRelease(c, row)));
}

export async function listPublishedReleaseNotes(c: AppContext, localeValue: string | null | undefined, versionValue?: string | null) {
  const locale = normalizeLocale(localeValue);
  const now = new Date().toISOString();
  const version = String(versionValue || "").trim().replace(/^v/i, "");
  const query = version
    ? "SELECT * FROM release_notes WHERE published = 1 AND (published_at IS NULL OR published_at <= ?) AND version = ? ORDER BY id DESC"
    : "SELECT * FROM release_notes WHERE published = 1 AND (published_at IS NULL OR published_at <= ?) ORDER BY published_at DESC, id DESC";
  const statement = c.env.merlin_db.prepare(query);
  const result = version
    ? await statement.bind(now, version).all<ReleaseRow>()
    : await statement.bind(now).all<ReleaseRow>();
  const mapped = await Promise.all((result.results || []).map((row) => mapLauncherRelease(c, row, locale)));
  return mapped.filter(Boolean);
}

async function writeLocalizations(c: AppContext, releaseId: number, localizations: ReturnType<typeof normalizeLocalization>[], now: string) {
  const statements = [c.env.merlin_db.prepare("DELETE FROM release_note_localizations WHERE release_note_id = ?").bind(releaseId)];
  for (const item of localizations) {
    statements.push(c.env.merlin_db.prepare(`
      INSERT INTO release_note_localizations (
        release_note_id, locale, title, subtitle, summary, highlights_json, full_content_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      releaseId, item.locale, item.title, item.subtitle, item.summary,
      JSON.stringify(item.highlights), JSON.stringify(item.fullContent), now, now
    ));
  }
  await c.env.merlin_db.batch(statements);
}

export async function createReleaseNote(c: AppContext, input: ReleaseNoteInput, file?: File | null) {
  const normalized = normalizeInput(input);
  const existing = await c.env.merlin_db.prepare("SELECT id FROM release_notes WHERE version = ? LIMIT 1").bind(normalized.version).first<{ id: number }>();
  if (existing) throw new HTTPException(409, { message: "Já existe uma novidade para esta versão." });
  let image: ReturnType<typeof normalizeImage> | null = null;
  let objectKey: string | null = null;
  if (file) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(500, { message: "Armazenamento de imagens indisponível." });
    image = normalizeImage(file);
    objectKey = `${RELEASE_ASSET_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" } });
  }
  const now = new Date().toISOString();
  try {
    const result = await c.env.merlin_db.prepare(`
      INSERT INTO release_notes (
        version, release_type, hero_asset_key, hero_asset_filename, hero_asset_content_type, hero_asset_size_bytes,
        published, published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      normalized.version, normalized.type, objectKey, image?.filename || null, image?.contentType || null, file?.size || 0,
      normalized.published ? 1 : 0, normalized.published ? (normalized.publishedAt || now) : normalized.publishedAt, now, now
    ).run();
    const id = Number(result.meta.last_row_id || 0);
    if (!id) throw new Error("Release insert failed");
    await writeLocalizations(c, id, normalized.localizations, now);
    return mapAdminRelease(c, await releaseRow(c, id));
  } catch (error) {
    if (objectKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(objectKey).catch(() => undefined);
    throw error;
  }
}

export async function updateReleaseNote(c: AppContext, value: string | number, input: ReleaseNoteInput, file?: File | null) {
  const existing = await releaseRow(c, value);
  const normalized = normalizeInput(input);
  const conflict = await c.env.merlin_db.prepare("SELECT id FROM release_notes WHERE version = ? AND id <> ? LIMIT 1").bind(normalized.version, existing.id).first<{ id: number }>();
  if (conflict) throw new HTTPException(409, { message: "Já existe uma novidade para esta versão." });

  let image = null as ReturnType<typeof normalizeImage> | null;
  let imageKey = existing.hero_asset_key;
  let imagePath = existing.hero_asset_path;
  let filename = existing.hero_asset_filename;
  let contentType = existing.hero_asset_content_type;
  let sizeBytes = existing.hero_asset_size_bytes;
  const oldKey = existing.hero_asset_key;
  if (normalized.removeHeroAsset || file) {
    imageKey = null; imagePath = null; filename = null; contentType = null; sizeBytes = 0;
  }
  if (file) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(500, { message: "Armazenamento de imagens indisponível." });
    image = normalizeImage(file);
    imageKey = `${RELEASE_ASSET_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    filename = image.filename; contentType = image.contentType; sizeBytes = file.size;
    await c.env.MERLIN_FILES.put(imageKey, await file.arrayBuffer(), { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" } });
  }
  const now = new Date().toISOString();
  try {
    await c.env.merlin_db.prepare(`
      UPDATE release_notes SET version = ?, release_type = ?, hero_asset_key = ?, hero_asset_path = ?,
        hero_asset_filename = ?, hero_asset_content_type = ?, hero_asset_size_bytes = ?, published = ?,
        published_at = ?, updated_at = ? WHERE id = ?
    `).bind(
      normalized.version, normalized.type, imageKey, imagePath, filename, contentType, sizeBytes,
      normalized.published ? 1 : 0, normalized.published ? (normalized.publishedAt || existing.published_at || now) : normalized.publishedAt,
      now, existing.id
    ).run();
    await writeLocalizations(c, existing.id, normalized.localizations, now);
    if (oldKey && oldKey !== imageKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(oldKey).catch(() => undefined);
    return mapAdminRelease(c, await releaseRow(c, existing.id));
  } catch (error) {
    if (imageKey && imageKey !== oldKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(imageKey).catch(() => undefined);
    throw error;
  }
}

export async function deleteReleaseNote(c: AppContext, value: string | number) {
  const row = await releaseRow(c, value);
  await c.env.merlin_db.prepare("DELETE FROM release_notes WHERE id = ?").bind(row.id).run();
  if (row.hero_asset_key && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(row.hero_asset_key).catch(() => undefined);
  return { success: true, id: row.id };
}

export async function getReleaseNoteHero(c: AppContext, value: string | number) {
  const row = await releaseRow(c, value);
  if (!row.hero_asset_key || !c.env.MERLIN_FILES) throw new HTTPException(404, { message: "Arte da release não encontrada." });
  const object = await c.env.MERLIN_FILES.get(row.hero_asset_key);
  if (!object) throw new HTTPException(404, { message: "Arte da release não encontrada." });
  return object;
}
