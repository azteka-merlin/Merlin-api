import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const PARTNER_IMAGE_PREFIX = "public-partners";
const MAX_PARTNER_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PartnerRow = {
  id: number;
  name: string;
  image_key: string | null;
  image_filename: string | null;
  image_content_type: string | null;
  image_size_bytes: number;
  image_crop_x: number | null;
  image_crop_y: number | null;
  image_crop_width: number | null;
  image_crop_height: number | null;
  youtube_url: string | null;
  tiktok_url: string | null;
  twitch_url: string | null;
  sort_order: number;
  active: number;
  created_at: string;
  updated_at: string;
};

export type PublicPartnerInput = {
  name?: string | null;
  youtubeUrl?: string | null;
  tiktokUrl?: string | null;
  twitchUrl?: string | null;
  sortOrder?: number | string | null;
  active?: boolean | null;
  removeImage?: boolean | null;
  imageCropX?: number | string | null;
  imageCropY?: number | string | null;
  imageCropWidth?: number | string | null;
  imageCropHeight?: number | string | null;
};

function normalizeId(value: string | number) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "Parceiro invalido." });
  return id;
}

function normalizeText(value: string | null | undefined) {
  const name = String(value || "").trim();
  if (!name) throw new HTTPException(400, { message: "Informe o nome do parceiro." });
  if (name.length > 80) throw new HTTPException(400, { message: "O nome deve ter no maximo 80 caracteres." });
  return name;
}

function normalizeOptionalUrl(value: string | null | undefined, label: string) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HTTPException(400, { message: `Informe um link valido para ${label}.` });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HTTPException(400, { message: `Informe um link valido para ${label}.` });
  if (url.toString().length > 500) throw new HTTPException(400, { message: `O link de ${label} deve ter no maximo 500 caracteres.` });
  return url.toString();
}

function normalizeSortOrder(value: number | string | null | undefined) {
  const sortOrder = Number(value ?? 0);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw new HTTPException(400, { message: "A ordem deve ser um numero entre 0 e 10000." });
  return sortOrder;
}

function normalizeCrop(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Math.min(100, Math.max(0, Number(numberValue.toFixed(4))));
}

function normalizeInput(input: PublicPartnerInput) {
  const imageCropX = normalizeCrop(input.imageCropX);
  const imageCropY = normalizeCrop(input.imageCropY);
  const imageCropWidth = normalizeCrop(input.imageCropWidth);
  const imageCropHeight = normalizeCrop(input.imageCropHeight);
  const crop = [imageCropX, imageCropY, imageCropWidth, imageCropHeight];
  const hasPartialCrop = crop.some((value) => value !== null);
  const hasCompleteCrop = crop.every((value) => value !== null);
  if (hasPartialCrop && !hasCompleteCrop) throw new HTTPException(400, { message: "Informe o enquadramento completo da imagem." });
  if (hasCompleteCrop && (!imageCropWidth || !imageCropHeight || imageCropX! + imageCropWidth > 100.0001 || imageCropY! + imageCropHeight > 100.0001)) throw new HTTPException(400, { message: "Enquadramento da imagem invalido." });
  return {
    name: normalizeText(input.name),
    youtubeUrl: normalizeOptionalUrl(input.youtubeUrl, "YouTube"),
    tiktokUrl: normalizeOptionalUrl(input.tiktokUrl, "TikTok"),
    twitchUrl: normalizeOptionalUrl(input.twitchUrl, "Twitch"),
    sortOrder: normalizeSortOrder(input.sortOrder),
    active: input.active !== false,
    removeImage: input.removeImage === true,
    imageCropX, imageCropY, imageCropWidth, imageCropHeight,
  };
}

function normalizeImageFile(file: File) {
  const contentType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new HTTPException(400, { message: "Envie uma imagem JPG, PNG ou WebP." });
  if (!file.size || file.size > MAX_PARTNER_IMAGE_BYTES) throw new HTTPException(400, { message: "A imagem deve ter ate 6 MB." });
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const safeName = String(file.name || `parceiro.${extension}`).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || `parceiro.${extension}`;
  return { contentType, extension, safeName };
}

function mapPartner(row: PartnerRow) {
  return {
    id: row.id,
    name: row.name,
    imageUrl: row.image_key ? `/api/public/partners/${row.id}/image?v=${encodeURIComponent(row.updated_at)}` : null,
    imageFilename: row.image_filename,
    imageContentType: row.image_content_type,
    imageSizeBytes: row.image_size_bytes,
    imageCropX: row.image_crop_x, imageCropY: row.image_crop_y, imageCropWidth: row.image_crop_width, imageCropHeight: row.image_crop_height,
    youtubeUrl: row.youtube_url, tiktokUrl: row.tiktok_url, twitchUrl: row.twitch_url,
    sortOrder: row.sort_order, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function getPartnerRow(c: AppContext, value: string | number) {
  const id = normalizeId(value);
  const row = await c.env.merlin_db.prepare(`
    SELECT id, name, image_key, image_filename, image_content_type, image_size_bytes,
      image_crop_x, image_crop_y, image_crop_width, image_crop_height,
      youtube_url, tiktok_url, twitch_url, sort_order, active, created_at, updated_at
    FROM public_partners WHERE id = ? LIMIT 1
  `).bind(id).first<PartnerRow>();
  if (!row) throw new HTTPException(404, { message: "Parceiro nao encontrado." });
  return row;
}

export async function listPublicPartners(c: AppContext, options: { includeInactive?: boolean } = {}) {
  const rows = await c.env.merlin_db.prepare(`
    SELECT id, name, image_key, image_filename, image_content_type, image_size_bytes,
      image_crop_x, image_crop_y, image_crop_width, image_crop_height,
      youtube_url, tiktok_url, twitch_url, sort_order, active, created_at, updated_at
    FROM public_partners
    WHERE ? = 1 OR active = 1
    ORDER BY active DESC, sort_order ASC, id ASC
  `).bind(options.includeInactive ? 1 : 0).all<PartnerRow>();
  return (rows.results || []).map(mapPartner);
}

export async function createPublicPartner(c: AppContext, input: PublicPartnerInput, file?: File | null) {
  const normalized = normalizeInput(input);
  if (!file) throw new HTTPException(400, { message: "Selecione uma foto do parceiro." });
  let image: ReturnType<typeof normalizeImageFile> | null = null;
  let objectKey: string | null = null;
  if (file) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(500, { message: "Armazenamento de imagens indisponivel." });
    image = normalizeImageFile(file);
    objectKey = `${PARTNER_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" } });
  }
  const nowIso = new Date().toISOString();
  const result = await c.env.merlin_db.prepare(`
    INSERT INTO public_partners (name, image_key, image_filename, image_content_type, image_size_bytes, image_crop_x, image_crop_y, image_crop_width, image_crop_height, youtube_url, tiktok_url, twitch_url, sort_order, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    normalized.name, objectKey, image?.safeName || null, image?.contentType || null, file?.size || 0,
    normalized.imageCropX, normalized.imageCropY, normalized.imageCropWidth, normalized.imageCropHeight,
    normalized.youtubeUrl, normalized.tiktokUrl, normalized.twitchUrl, normalized.sortOrder, normalized.active ? 1 : 0, nowIso, nowIso,
  ).run();
  const id = Number(result.meta.last_row_id || 0);
  if (!id) {
    if (objectKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(objectKey).catch(() => undefined);
    throw new HTTPException(500, { message: "Nao foi possivel criar o parceiro." });
  }
  return mapPartner(await getPartnerRow(c, id));
}

export async function updatePublicPartner(c: AppContext, value: string | number, input: PublicPartnerInput, file?: File | null) {
  const id = normalizeId(value);
  const existing = await getPartnerRow(c, id);
  const normalized = normalizeInput(input);
  if (normalized.removeImage && !file) throw new HTTPException(400, { message: "Um parceiro precisa ter uma foto." });
  let image: ReturnType<typeof normalizeImageFile> | null = null;
  let objectKey = existing.image_key;
  let filename = existing.image_filename;
  let contentType = existing.image_content_type;
  let sizeBytes = existing.image_size_bytes;
  let oldObjectKey: string | null = null;
  if (normalized.removeImage || file) {
    oldObjectKey = existing.image_key;
    objectKey = null; filename = null; contentType = null; sizeBytes = 0;
  }
  if (file) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(500, { message: "Armazenamento de imagens indisponivel." });
    image = normalizeImageFile(file);
    objectKey = `${PARTNER_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    filename = image.safeName; contentType = image.contentType; sizeBytes = file.size;
    await c.env.MERLIN_FILES.put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" } });
  }
  await c.env.merlin_db.prepare(`
    UPDATE public_partners SET name = ?, image_key = ?, image_filename = ?, image_content_type = ?, image_size_bytes = ?, image_crop_x = ?, image_crop_y = ?, image_crop_width = ?, image_crop_height = ?, youtube_url = ?, tiktok_url = ?, twitch_url = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?
  `).bind(
    normalized.name, objectKey, filename, contentType, sizeBytes,
    normalized.imageCropX, normalized.imageCropY, normalized.imageCropWidth, normalized.imageCropHeight,
    normalized.youtubeUrl, normalized.tiktokUrl, normalized.twitchUrl, normalized.sortOrder, normalized.active ? 1 : 0, new Date().toISOString(), id,
  ).run();
  if (oldObjectKey && oldObjectKey !== objectKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(oldObjectKey).catch(() => undefined);
  return mapPartner(await getPartnerRow(c, id));
}

export async function deletePublicPartner(c: AppContext, value: string | number) {
  const row = await getPartnerRow(c, value);
  await c.env.merlin_db.prepare("DELETE FROM public_partners WHERE id = ?").bind(row.id).run();
  if (row.image_key && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(row.image_key).catch(() => undefined);
  return { success: true, id: row.id };
}

export async function getPublicPartnerImageObject(c: AppContext, value: string | number) {
  const row = await getPartnerRow(c, value);
  if (!row.image_key || !c.env.MERLIN_FILES) throw new HTTPException(404, { message: "Imagem nao encontrada." });
  const object = await c.env.MERLIN_FILES.get(row.image_key);
  if (!object) throw new HTTPException(404, { message: "Imagem nao encontrada." });
  return { row, object };
}
