import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const ANNOUNCEMENT_IMAGE_PREFIX = "announcements";
const MAX_ANNOUNCEMENT_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_TIME = "0000-01-01T00:00:00.000Z";
const MAX_TIME = "9999-12-31T23:59:59.999Z";
const BACKEND_DAY_TIMEZONE = "America/Sao_Paulo";

type AnnouncementFrequency = "always" | "once_per_day" | "once";
type AnnouncementImageFit = "cover" | "contain";

type AnnouncementRow = {
  id: number;
  internal_name: string;
  title: string;
  body_text: string;
  image_key: string | null;
  image_filename: string | null;
  image_content_type: string | null;
  image_size_bytes: number;
  image_fit: AnnouncementImageFit;
  image_position_x: number;
  image_position_y: number;
  image_crop_x: number | null;
  image_crop_y: number | null;
  image_crop_width: number | null;
  image_crop_height: number | null;
  active: number;
  starts_at: string | null;
  ends_at: string | null;
  frequency: AnnouncementFrequency;
  allow_dismiss_forever: number;
  created_at: string;
  updated_at: string;
  total_views?: number | null;
  dismissed_count?: number | null;
};

type AnnouncementStateRow = {
  id: number;
  announcement_id: number;
  license_id: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  dismissed_forever: number;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AnnouncementInput = {
  internalName?: string | null;
  title?: string | null;
  bodyText?: string | null;
  active?: boolean | null;
  startsAt?: string | null;
  endsAt?: string | null;
  frequency?: string | null;
  allowDismissForever?: boolean | null;
  removeImage?: boolean | null;
  imageFit?: string | null;
  imagePositionX?: number | string | null;
  imagePositionY?: number | string | null;
  imageCropX?: number | string | null;
  imageCropY?: number | string | null;
  imageCropWidth?: number | string | null;
  imageCropHeight?: number | string | null;
};

function normalizeId(value: string | number, label = "announcement id") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: `Invalid ${label}` });
  }
  return id;
}

function normalizeText(value: string | null | undefined, field: string, maxLength: number) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new HTTPException(400, { message: `Informe ${field}.` });
  }
  if (normalized.length > maxLength) {
    throw new HTTPException(400, { message: `${field} deve ter no maximo ${maxLength} caracteres.` });
  }
  return normalized;
}

function normalizeOptionalDate(value: string | null | undefined, field: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new HTTPException(400, { message: `Data invalida em ${field}.` });
  }
  return date.toISOString();
}

function normalizeFrequency(value: string | null | undefined): AnnouncementFrequency {
  if (value === "once_per_day" || value === "once") return value;
  return "always";
}

function normalizeImageFit(value: string | null | undefined): AnnouncementImageFit {
  return value === "contain" ? "contain" : "cover";
}

function normalizePercent(value: number | string | null | undefined) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 50;
  return Math.min(100, Math.max(0, Math.round(numberValue)));
}

function normalizeOptionalCropPercent(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Math.min(100, Math.max(0, Number(numberValue.toFixed(4))));
}

function normalizeImageFile(file: File) {
  const contentType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new HTTPException(400, { message: "Envie uma imagem JPG, PNG ou WebP." });
  }

  if (!file.size || file.size > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
    throw new HTTPException(400, { message: "A imagem deve ter ate 6 MB." });
  }

  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const safeName = String(file.name || `comunicado.${extension}`)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || `comunicado.${extension}`;

  return { contentType, extension, safeName };
}

function normalizeInput(input: AnnouncementInput) {
  const internalName = normalizeText(input.internalName, "o nome interno", 140);
  const title = normalizeText(input.title, "o titulo", 180);
  const bodyText = normalizeText(input.bodyText, "o texto", 3000);
  const startsAt = normalizeOptionalDate(input.startsAt, "inicio");
  const endsAt = normalizeOptionalDate(input.endsAt, "termino");
  const imageCropX = normalizeOptionalCropPercent(input.imageCropX);
  const imageCropY = normalizeOptionalCropPercent(input.imageCropY);
  const imageCropWidth = normalizeOptionalCropPercent(input.imageCropWidth);
  const imageCropHeight = normalizeOptionalCropPercent(input.imageCropHeight);
  const hasPartialCrop = [imageCropX, imageCropY, imageCropWidth, imageCropHeight].some((value) => value !== null);
  const hasCompleteCrop = [imageCropX, imageCropY, imageCropWidth, imageCropHeight].every((value) => value !== null);

  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new HTTPException(400, { message: "A data de termino deve ser posterior ao inicio." });
  }
  if (hasPartialCrop && !hasCompleteCrop) {
    throw new HTTPException(400, { message: "Informe o enquadramento completo da imagem." });
  }
  if (hasCompleteCrop) {
    if (!imageCropWidth || !imageCropHeight || imageCropX! + imageCropWidth > 100.0001 || imageCropY! + imageCropHeight > 100.0001) {
      throw new HTTPException(400, { message: "Enquadramento da imagem invalido." });
    }
  }

  return {
    internalName,
    title,
    bodyText,
    active: input.active === true,
    startsAt,
    endsAt,
    frequency: normalizeFrequency(input.frequency),
    allowDismissForever: input.allowDismissForever === true,
    removeImage: input.removeImage === true,
    imageFit: normalizeImageFit(input.imageFit),
    imagePositionX: normalizePercent(input.imagePositionX),
    imagePositionY: normalizePercent(input.imagePositionY),
    imageCropX,
    imageCropY,
    imageCropWidth,
    imageCropHeight,
  };
}

function getAnnouncementImagePath(row: AnnouncementRow, audience: "admin" | "launcher") {
  if (!row.image_key) return null;
  const prefix = audience === "admin" ? "/panel-api" : "/api";
  return `${prefix}/announcements/${row.id}/image?v=${encodeURIComponent(row.updated_at)}`;
}

function deriveStatus(row: AnnouncementRow, nowIso = new Date().toISOString()) {
  if (!row.active) return "inactive";
  if (row.starts_at && row.starts_at > nowIso) return "scheduled";
  if (row.ends_at && row.ends_at <= nowIso) return "ended";
  return "active";
}

function backendDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BACKEND_DAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isStateEligible(row: AnnouncementRow, state: AnnouncementStateRow | null, nowIso: string) {
  if (!state) return true;
  if (state.dismissed_forever) return false;
  if (row.frequency === "always") return true;
  if (row.frequency === "once") return !state.first_viewed_at && !state.view_count;
  if (row.frequency === "once_per_day") {
    if (!state.last_viewed_at) return true;
    return backendDayKey(state.last_viewed_at) !== backendDayKey(nowIso);
  }
  return true;
}

function mapAnnouncement(row: AnnouncementRow, audience: "admin" | "launcher" = "admin", nowIso = new Date().toISOString()) {
  return {
    id: row.id,
    internalName: row.internal_name,
    title: row.title,
    bodyText: row.body_text,
    imageUrl: getAnnouncementImagePath(row, audience),
    imageFilename: row.image_filename,
    imageContentType: row.image_content_type,
    imageSizeBytes: row.image_size_bytes,
    imageFit: normalizeImageFit(row.image_fit),
    imagePositionX: normalizePercent(row.image_position_x),
    imagePositionY: normalizePercent(row.image_position_y),
    imageCropX: row.image_crop_x,
    imageCropY: row.image_crop_y,
    imageCropWidth: row.image_crop_width,
    imageCropHeight: row.image_crop_height,
    active: Boolean(row.active),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    frequency: row.frequency,
    allowDismissForever: Boolean(row.allow_dismiss_forever),
    status: deriveStatus(row, nowIso),
    metrics: {
      totalViews: Number(row.total_views || 0),
      dismissedForever: Number(row.dismissed_count || 0),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getAnnouncementRow(c: AppContext, value: string | number) {
  const id = normalizeId(value);
  const row = await c.env.merlin_db
    .prepare(`
      SELECT
        a.id, a.internal_name, a.title, a.body_text,
        a.image_key, a.image_filename, a.image_content_type, a.image_size_bytes,
        a.image_fit, a.image_position_x, a.image_position_y,
        a.image_crop_x, a.image_crop_y, a.image_crop_width, a.image_crop_height,
        a.active, a.starts_at, a.ends_at, a.frequency, a.allow_dismiss_forever,
        a.created_at, a.updated_at,
        COALESCE(SUM(aus.view_count), 0) AS total_views,
        COALESCE(SUM(CASE WHEN aus.dismissed_forever = 1 THEN 1 ELSE 0 END), 0) AS dismissed_count
      FROM announcements a
      LEFT JOIN announcement_user_state aus ON aus.announcement_id = a.id
      WHERE a.id = ?
      GROUP BY a.id
      LIMIT 1
    `)
    .bind(id)
    .first<AnnouncementRow>();

  if (!row) {
    throw new HTTPException(404, { message: "Comunicado nao encontrado." });
  }
  return row;
}

async function loadUserState(c: AppContext, announcementId: number, licenseId: number) {
  return c.env.merlin_db
    .prepare(`
      SELECT id, announcement_id, license_id, first_viewed_at, last_viewed_at, view_count,
        dismissed_forever, dismissed_at, created_at, updated_at
      FROM announcement_user_state
      WHERE announcement_id = ? AND license_id = ?
      LIMIT 1
    `)
    .bind(announcementId, licenseId)
    .first<AnnouncementStateRow>();
}

async function assertNoActiveWindowConflict(c: AppContext, input: ReturnType<typeof normalizeInput>, ignoreId?: number | null) {
  if (!input.active) return;

  const newStart = input.startsAt || MIN_TIME;
  const newEnd = input.endsAt || MAX_TIME;
  const conflict = await c.env.merlin_db
    .prepare(`
      SELECT id, internal_name, starts_at, ends_at
      FROM announcements
      WHERE active = 1
        AND (? IS NULL OR id <> ?)
        AND COALESCE(ends_at, ?) > ?
        AND COALESCE(starts_at, ?) < ?
      ORDER BY starts_at IS NULL DESC, starts_at ASC, id ASC
      LIMIT 1
    `)
    .bind(ignoreId || null, ignoreId || null, MAX_TIME, newStart, MIN_TIME, newEnd)
    .first<{ id: number; internal_name: string; starts_at: string | null; ends_at: string | null }>();

  if (conflict) {
    throw new HTTPException(409, {
      message: `Conflito com o comunicado "${conflict.internal_name}" (#${conflict.id}). Desative ou ajuste o periodo dele antes de salvar.`,
    });
  }
}

export async function listAnnouncements(c: AppContext) {
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT
        a.id, a.internal_name, a.title, a.body_text,
        a.image_key, a.image_filename, a.image_content_type, a.image_size_bytes,
        a.image_fit, a.image_position_x, a.image_position_y,
        a.image_crop_x, a.image_crop_y, a.image_crop_width, a.image_crop_height,
        a.active, a.starts_at, a.ends_at, a.frequency, a.allow_dismiss_forever,
        a.created_at, a.updated_at,
        COALESCE(SUM(aus.view_count), 0) AS total_views,
        COALESCE(SUM(CASE WHEN aus.dismissed_forever = 1 THEN 1 ELSE 0 END), 0) AS dismissed_count
      FROM announcements a
      LEFT JOIN announcement_user_state aus ON aus.announcement_id = a.id
      GROUP BY a.id
      ORDER BY a.active DESC, a.updated_at DESC, a.id DESC
    `)
    .all<AnnouncementRow>();

  const nowIso = new Date().toISOString();
  return (rows.results || []).map((row) => mapAnnouncement(row, "admin", nowIso));
}

export async function createAnnouncement(c: AppContext, input: AnnouncementInput, file?: File | null) {
  const normalized = normalizeInput(input);
  await assertNoActiveWindowConflict(c, normalized);

  let image: ReturnType<typeof normalizeImageFile> | null = null;
  let objectKey: string | null = null;
  if (file) {
    if (!c.env.MERLIN_FILES) {
      throw new HTTPException(500, { message: "MERLIN_FILES binding is not configured" });
    }
    image = normalizeImageFile(file);
    objectKey = `${ANNOUNCEMENT_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: image.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  }

  const nowIso = new Date().toISOString();
  const result = await c.env.merlin_db
    .prepare(`
      INSERT INTO announcements (
        internal_name, title, body_text, image_key, image_filename, image_content_type, image_size_bytes,
        image_fit, image_position_x, image_position_y,
        image_crop_x, image_crop_y, image_crop_width, image_crop_height,
        active, starts_at, ends_at, frequency, allow_dismiss_forever, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      normalized.internalName,
      normalized.title,
      normalized.bodyText,
      objectKey,
      image?.safeName || null,
      image?.contentType || null,
      file?.size || 0,
      normalized.imageFit,
      normalized.imagePositionX,
      normalized.imagePositionY,
      normalized.imageCropX,
      normalized.imageCropY,
      normalized.imageCropWidth,
      normalized.imageCropHeight,
      normalized.active ? 1 : 0,
      normalized.startsAt,
      normalized.endsAt,
      normalized.frequency,
      normalized.allowDismissForever ? 1 : 0,
      nowIso,
      nowIso
    )
    .run();

  const id = Number(result.meta.last_row_id || 0);
  if (!id) {
    if (objectKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(objectKey).catch(() => undefined);
    throw new HTTPException(500, { message: "Nao foi possivel criar o comunicado." });
  }

  return mapAnnouncement(await getAnnouncementRow(c, id));
}

export async function updateAnnouncement(c: AppContext, value: string | number, input: AnnouncementInput, file?: File | null) {
  const id = normalizeId(value);
  const existing = await getAnnouncementRow(c, id);
  const normalized = normalizeInput(input);
  await assertNoActiveWindowConflict(c, normalized, id);

  let image: ReturnType<typeof normalizeImageFile> | null = null;
  let objectKey = existing.image_key;
  let filename = existing.image_filename;
  let contentType = existing.image_content_type;
  let sizeBytes = existing.image_size_bytes || 0;
  let oldObjectKey: string | null = null;

  if (normalized.removeImage || file) {
    oldObjectKey = existing.image_key;
    objectKey = null;
    filename = null;
    contentType = null;
    sizeBytes = 0;
  }

  if (file) {
    if (!c.env.MERLIN_FILES) {
      throw new HTTPException(500, { message: "MERLIN_FILES binding is not configured" });
    }
    image = normalizeImageFile(file);
    objectKey = `${ANNOUNCEMENT_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    filename = image.safeName;
    contentType = image.contentType;
    sizeBytes = file.size;
    await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: image.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  }

  await c.env.merlin_db
    .prepare(`
      UPDATE announcements
      SET internal_name = ?, title = ?, body_text = ?,
        image_key = ?, image_filename = ?, image_content_type = ?, image_size_bytes = ?,
        image_fit = ?, image_position_x = ?, image_position_y = ?,
        image_crop_x = ?, image_crop_y = ?, image_crop_width = ?, image_crop_height = ?,
        active = ?, starts_at = ?, ends_at = ?, frequency = ?, allow_dismiss_forever = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(
      normalized.internalName,
      normalized.title,
      normalized.bodyText,
      objectKey,
      filename,
      contentType,
      sizeBytes,
      normalized.imageFit,
      normalized.imagePositionX,
      normalized.imagePositionY,
      normalized.imageCropX,
      normalized.imageCropY,
      normalized.imageCropWidth,
      normalized.imageCropHeight,
      normalized.active ? 1 : 0,
      normalized.startsAt,
      normalized.endsAt,
      normalized.frequency,
      normalized.allowDismissForever ? 1 : 0,
      new Date().toISOString(),
      id
    )
    .run();

  if (oldObjectKey && oldObjectKey !== objectKey && c.env.MERLIN_FILES) {
    await c.env.MERLIN_FILES.delete(oldObjectKey).catch(() => undefined);
  }

  return mapAnnouncement(await getAnnouncementRow(c, id));
}

export async function deleteAnnouncement(c: AppContext, value: string | number) {
  const row = await getAnnouncementRow(c, value);
  await c.env.merlin_db.prepare("DELETE FROM announcements WHERE id = ?").bind(row.id).run();
  if (row.image_key && c.env.MERLIN_FILES) {
    await c.env.MERLIN_FILES.delete(row.image_key).catch(() => undefined);
  }
  return { success: true, id: row.id };
}

export async function getAnnouncementImageObject(c: AppContext, value: string | number) {
  const row = await getAnnouncementRow(c, value);
  if (!row.image_key || !c.env.MERLIN_FILES) {
    throw new HTTPException(404, { message: "Imagem nao encontrada." });
  }
  const object = await c.env.MERLIN_FILES.get(row.image_key);
  if (!object) {
    throw new HTTPException(404, { message: "Imagem nao encontrada." });
  }
  return { row, object };
}

export async function getEligibleAnnouncement(c: AppContext, licenseId: number) {
  const nowIso = new Date().toISOString();
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT id, internal_name, title, body_text,
        image_key, image_filename, image_content_type, image_size_bytes,
        image_fit, image_position_x, image_position_y,
        image_crop_x, image_crop_y, image_crop_width, image_crop_height,
        active, starts_at, ends_at, frequency, allow_dismiss_forever,
        created_at, updated_at
      FROM announcements
      WHERE active = 1
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY starts_at IS NULL ASC, starts_at DESC, updated_at DESC, id DESC
      LIMIT 5
    `)
    .bind(nowIso, nowIso)
    .all<AnnouncementRow>();

  for (const row of rows.results || []) {
    const state = await loadUserState(c, row.id, licenseId);
    if (isStateEligible(row, state || null, nowIso)) {
      return mapAnnouncement(row, "launcher", nowIso);
    }
  }

  return null;
}

export async function recordAnnouncementView(c: AppContext, value: string | number, licenseId: number) {
  const id = normalizeId(value);
  const row = await getAnnouncementRow(c, id);
  const nowIso = new Date().toISOString();
  if (deriveStatus(row, nowIso) !== "active") {
    throw new HTTPException(409, { message: "Comunicado nao esta ativo." });
  }

  await c.env.merlin_db
    .prepare(`
      INSERT INTO announcement_user_state (
        announcement_id, license_id, first_viewed_at, last_viewed_at, view_count,
        dismissed_forever, dismissed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)
      ON CONFLICT(announcement_id, license_id) DO UPDATE SET
        first_viewed_at = COALESCE(first_viewed_at, excluded.first_viewed_at),
        last_viewed_at = excluded.last_viewed_at,
        view_count = view_count + 1,
        updated_at = excluded.updated_at
    `)
    .bind(id, licenseId, nowIso, nowIso, nowIso, nowIso)
    .run();

  return { success: true, id };
}

export async function dismissAnnouncementForever(c: AppContext, value: string | number, licenseId: number) {
  const id = normalizeId(value);
  const row = await getAnnouncementRow(c, id);
  if (!row.allow_dismiss_forever) {
    throw new HTTPException(409, { message: "Este comunicado nao permite nao mostrar novamente." });
  }

  const nowIso = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      INSERT INTO announcement_user_state (
        announcement_id, license_id, first_viewed_at, last_viewed_at, view_count,
        dismissed_forever, dismissed_at, created_at, updated_at
      )
      VALUES (?, ?, NULL, NULL, 0, 1, ?, ?, ?)
      ON CONFLICT(announcement_id, license_id) DO UPDATE SET
        dismissed_forever = 1,
        dismissed_at = excluded.dismissed_at,
        updated_at = excluded.updated_at
    `)
    .bind(id, licenseId, nowIso, nowIso, nowIso)
    .run();

  return { success: true, id };
}
