import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const FEEDBACK_IMAGE_PREFIX = "public-feedbacks";
const MAX_FEEDBACK_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PublicFeedbackImageRow = {
  id: number;
  title: string;
  image_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sort_order: number;
  enabled: number;
  source: string;
  static_url: string | null;
  created_at: string;
  updated_at: string;
};

type PublicFeedbackImageInput = {
  title?: string | null;
  sortOrder?: number | null;
  enabled?: boolean | null;
};

function mapFeedback(row: PublicFeedbackImageRow) {
  const source = row.source === "static" ? "static" : "uploaded";
  return {
    id: row.id,
    title: row.title,
    source,
    imageUrl: source === "static" && row.static_url ? row.static_url : `/api/public/feedbacks/${row.id}/image`,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTitle(value?: string | null) {
  const normalized = String(value || "").trim();
  return normalized || "Feedback Merlin";
}

function normalizeSortOrder(value?: number | null) {
  const sortOrder = Math.trunc(Number(value ?? 0));
  return Number.isFinite(sortOrder) ? sortOrder : 0;
}

function normalizeImageFile(file: File) {
  const contentType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new HTTPException(400, { message: "Envie uma imagem JPG, PNG ou WebP." });
  }

  if (!file.size || file.size > MAX_FEEDBACK_IMAGE_BYTES) {
    throw new HTTPException(400, { message: "A imagem deve ter ate 6 MB." });
  }

  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const safeName = String(file.name || `feedback.${extension}`)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || `feedback.${extension}`;

  return { contentType, extension, safeName };
}

async function getFeedbackRow(c: AppContext, id: number) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "Invalid feedback id" });
  }

  const row = await c.env.merlin_db
    .prepare(`
      SELECT id, title, image_key, filename, content_type, size_bytes, sort_order, enabled, created_at, updated_at
      , source, static_url
      FROM public_feedback_images
      WHERE id = ?
      LIMIT 1
    `)
    .bind(id)
    .first<PublicFeedbackImageRow>();

  if (!row) {
    throw new HTTPException(404, { message: "Feedback not found" });
  }

  return row;
}

export async function listPublicFeedbackImages(c: AppContext, options: { includeDisabled?: boolean } = {}) {
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT id, title, image_key, filename, content_type, size_bytes, sort_order, enabled, created_at, updated_at
      , source, static_url
      FROM public_feedback_images
      ${options.includeDisabled ? "" : "WHERE enabled = 1"}
      ORDER BY sort_order ASC, id ASC
    `)
    .all<PublicFeedbackImageRow>();

  return (rows.results || []).map(mapFeedback);
}

export async function createPublicFeedbackImage(c: AppContext, file: File, input: PublicFeedbackImageInput) {
  if (!c.env.MERLIN_FILES) {
    throw new HTTPException(500, { message: "MERLIN_FILES binding is not configured" });
  }

  const image = normalizeImageFile(file);
  const nowIso = new Date().toISOString();
  const objectKey = `${FEEDBACK_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;

  await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: image.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const result = await c.env.merlin_db
    .prepare(`
      INSERT INTO public_feedback_images (title, image_key, filename, content_type, size_bytes, sort_order, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      normalizeTitle(input.title),
      objectKey,
      image.safeName,
      image.contentType,
      file.size,
      normalizeSortOrder(input.sortOrder),
      input.enabled === false ? 0 : 1,
      nowIso,
      nowIso
    )
    .run();

  const id = Number(result.meta.last_row_id || 0);
  if (!id) {
    await c.env.MERLIN_FILES.delete(objectKey).catch(() => undefined);
    throw new HTTPException(500, { message: "Could not create feedback image" });
  }

  return mapFeedback(await getFeedbackRow(c, id));
}

export async function updatePublicFeedbackImage(c: AppContext, id: number, input: PublicFeedbackImageInput) {
  await getFeedbackRow(c, id);
  const nowIso = new Date().toISOString();

  await c.env.merlin_db
    .prepare(`
      UPDATE public_feedback_images
      SET title = ?, sort_order = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(
      normalizeTitle(input.title),
      normalizeSortOrder(input.sortOrder),
      input.enabled === false ? 0 : 1,
      nowIso,
      id
    )
    .run();

  return mapFeedback(await getFeedbackRow(c, id));
}

export async function deletePublicFeedbackImage(c: AppContext, id: number) {
  const row = await getFeedbackRow(c, id);
  await c.env.merlin_db.prepare("DELETE FROM public_feedback_images WHERE id = ?").bind(id).run();
  if (row.source !== "static" && c.env.MERLIN_FILES) {
    await c.env.MERLIN_FILES.delete(row.image_key).catch(() => undefined);
  }
  return { success: true, id };
}

export async function getPublicFeedbackImageObject(c: AppContext, id: number) {
  const row = await getFeedbackRow(c, id);
  if (!row.enabled) {
    throw new HTTPException(404, { message: "Feedback not found" });
  }
  if (row.source === "static") {
    throw new HTTPException(404, { message: "Feedback image is static" });
  }

  const object = await c.env.MERLIN_FILES.get(row.image_key);
  if (!object) {
    throw new HTTPException(404, { message: "Feedback image not found" });
  }

  return { row, object };
}
