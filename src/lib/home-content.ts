import { HTTPException } from "hono/http-exception";
import { resolveSteamGameByAppId, searchGamesForCatalog } from "../endpoints/games-search";
import type { AppContext } from "../types";

const HOME_IMAGE_PREFIX = "home";
const HOME_REMOTE_IMAGE_CACHE_PREFIX = "home/remote-cache";
const MAX_HOME_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SLOT_LIMITS = { hero: 30, side: 2, showcase: 4 } as const;

function originLabel(url: string) {
  try { return new URL(url).hostname; } catch { return "invalid_url"; }
}

export type HomeSlotType = keyof typeof SLOT_LIMITS;
type HomeAction = "none" | "premium" | "add_game";
type HomeImageMode = "steam" | "custom";

type HomeContentRow = {
  id: number;
  slot_type: HomeSlotType;
  position: number;
  app_id: string | null;
  title: string;
  description: string | null;
  secondary_text: string | null;
  display_label: string | null;
  image_mode: HomeImageMode;
  image_url: string | null;
  image_key: string | null;
  image_filename: string | null;
  image_content_type: string | null;
  image_size_bytes: number;
  image_position_x: number;
  image_position_y: number;
  image_zoom: number;
  primary_action: HomeAction;
  secondary_action: HomeAction;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type HomeContentInput = {
  slotType?: string | null;
  position?: number | string | null;
  appId?: string | null;
  title?: string | null;
  description?: string | null;
  secondaryText?: string | null;
  displayLabel?: string | null;
  imageMode?: string | null;
  imagePositionX?: number | string | null;
  imagePositionY?: number | string | null;
  imageZoom?: number | string | null;
  primaryAction?: string | null;
  secondaryAction?: string | null;
  enabled?: boolean | null;
  removeImage?: boolean | null;
};

function normalizeId(value: string | number) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "Item da Home invalido." });
  return id;
}

function normalizeSlotType(value: unknown): HomeSlotType {
  if (value === "hero" || value === "side" || value === "showcase") return value;
  throw new HTTPException(400, { message: "Slot da Home invalido." });
}

function normalizePosition(value: unknown, slotType: HomeSlotType) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 1 || position > SLOT_LIMITS[slotType]) {
    throw new HTTPException(400, { message: "Posicao da Home invalida." });
  }
  return position;
}

function normalizeText(value: unknown, field: string, maxLength: number, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new HTTPException(400, { message: `Informe ${field}.` });
  if (text.length > maxLength) throw new HTTPException(400, { message: `${field} deve ter no maximo ${maxLength} caracteres.` });
  return text || null;
}

function normalizePercent(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 50;
  return Math.min(100, Math.max(0, Number(numberValue.toFixed(2))));
}

function normalizeZoom(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(4, Math.max(1, Number(number.toFixed(2))));
}

function normalizeAction(value: unknown): HomeAction {
  return value === "premium" || value === "add_game" ? value : "none";
}

function normalizeImageMode(value: unknown): HomeImageMode {
  return value === "custom" ? "custom" : "steam";
}

function normalizeImageFile(file: File) {
  const contentType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new HTTPException(400, { message: "Envie uma imagem JPG, PNG ou WebP." });
  if (!file.size || file.size > MAX_HOME_IMAGE_BYTES) throw new HTTPException(400, { message: "A imagem deve ter ate 8 MB." });
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const safeName = String(file.name || `home.${extension}`).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || `home.${extension}`;
  return { contentType, extension, safeName };
}

function normalizeInput(input: HomeContentInput, forcedSlotType?: HomeSlotType) {
  const slotType = forcedSlotType || normalizeSlotType(input.slotType);
  const appId = String(input.appId || "").trim();
  if (appId && !/^\d+$/.test(appId)) throw new HTTPException(400, { message: "App ID invalido." });
  return {
    slotType,
    position: normalizePosition(input.position, slotType),
    appId: appId || null,
    title: normalizeText(input.title, "o titulo", 180, true)!,
    description: normalizeText(input.description, "a descricao", 800),
    secondaryText: normalizeText(input.secondaryText, "o texto secundario", 180),
    displayLabel: normalizeText(input.displayLabel, "a label", 120),
    imageMode: normalizeImageMode(input.imageMode),
    imagePositionX: normalizePercent(input.imagePositionX),
    imagePositionY: normalizePercent(input.imagePositionY),
    imageZoom: normalizeZoom(input.imageZoom),
    primaryAction: slotType === "hero" ? normalizeAction(input.primaryAction) : "none" as HomeAction,
    secondaryAction: slotType === "hero" ? normalizeAction(input.secondaryAction) : "none" as HomeAction,
    enabled: input.enabled !== false,
    removeImage: input.removeImage === true,
  };
}

function imagePath(row: HomeContentRow) {
  return row.image_key || row.image_url
    ? `/api/home/items/${row.id}/image?v=${encodeURIComponent(row.updated_at)}`
    : null;
}

function mapRow(row: HomeContentRow) {
  return {
    id: row.id,
    slotType: row.slot_type,
    position: row.position,
    appId: row.app_id,
    title: row.title,
    description: row.description,
    secondaryText: row.secondary_text,
    displayLabel: row.display_label,
    imageMode: row.image_mode,
    imageUrl: imagePath(row),
    imageFilename: row.image_filename,
    imagePositionX: Number(row.image_position_x),
    imagePositionY: Number(row.image_position_y),
    imageZoom: normalizeZoom(row.image_zoom),
    primaryAction: row.primary_action,
    secondaryAction: row.secondary_action,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRow(c: AppContext, value: string | number) {
  const row = await c.env.merlin_db.prepare("SELECT * FROM home_content_items WHERE id = ?").bind(normalizeId(value)).first<HomeContentRow>();
  if (!row) throw new HTTPException(404, { message: "Item da Home nao encontrado." });
  return row;
}

export async function listHomeContent(c: AppContext, includeDisabled = false) {
  const result = await c.env.merlin_db.prepare(`
    SELECT * FROM home_content_items
    ${includeDisabled ? "" : "WHERE enabled = 1"}
    ORDER BY CASE slot_type WHEN 'hero' THEN 1 WHEN 'side' THEN 2 ELSE 3 END, position, id
  `).all<HomeContentRow>();
  const items = (result.results || []).map(mapRow);
  const updatedAt = items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, "");
  return {
    hero: items.filter((item) => item.slotType === "hero"),
    side: items.filter((item) => item.slotType === "side").slice(0, 2),
    showcase: items.filter((item) => item.slotType === "showcase").slice(0, 4),
    updatedAt,
    revision: `${items.length}:${updatedAt}`,
  };
}

export async function getHomeContentRevision(c: AppContext) {
  const row = await c.env.merlin_db.prepare(`
    SELECT COUNT(*) AS item_count, MAX(updated_at) AS updated_at
    FROM home_content_items
    WHERE enabled = 1
  `).first<{ item_count: number; updated_at: string | null }>();
  const itemCount = Math.max(0, Number(row?.item_count || 0));
  const updatedAt = typeof row?.updated_at === "string" ? row.updated_at : "";
  return { updatedAt, revision: `${itemCount}:${updatedAt}` };
}

export async function resolveHomeSteamGame(c: AppContext, appIdValue: string) {
  const appId = String(appIdValue || "").trim();
  if (!/^\d+$/.test(appId)) throw new HTTPException(400, { message: "App ID invalido." });
  const existing = await c.env.merlin_db.prepare("SELECT app_id, name, cover_url, cover_source FROM games_catalog WHERE app_id = ? LIMIT 1").bind(appId).first<{ app_id: string; name: string; cover_url: string | null; cover_source: string | null }>();
  if (existing?.cover_url) return { appId, name: existing.name, coverUrl: existing.cover_url, coverSource: existing.cover_source };
  const matches = await searchGamesForCatalog(c, appId, 1);
  const match = matches.find((entry) => entry.appId === appId);
  if (match?.coverUrl) return match;

  const steamGame = await resolveSteamGameByAppId(appId);
  if (!steamGame) throw new HTTPException(404, { message: "Nao foi possivel localizar uma imagem para este App ID." });
  return steamGame;
}

async function prepareImage(c: AppContext, normalized: ReturnType<typeof normalizeInput>, file: File | null | undefined, existing?: HomeContentRow) {
  let imageUrl = existing?.image_url || null;
  let imageKey = existing?.image_key || null;
  let imageFilename = existing?.image_filename || null;
  let imageContentType = existing?.image_content_type || null;
  let imageSizeBytes = existing?.image_size_bytes || 0;
  let oldImageKey: string | null = null;

  if (normalized.removeImage || file || normalized.imageMode !== existing?.image_mode) {
    oldImageKey = imageKey;
    imageUrl = null;
    imageKey = null;
    imageFilename = null;
    imageContentType = null;
    imageSizeBytes = 0;
  }

  if (normalized.imageMode === "steam") {
    if (!normalized.appId) throw new HTTPException(400, { message: "Informe o App ID para usar a imagem automatica." });
    const game = await resolveHomeSteamGame(c, normalized.appId);
    imageUrl = game.coverUrl;
  } else if (file) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(500, { message: "Armazenamento de imagens indisponivel." });
    const image = normalizeImageFile(file);
    imageKey = `${HOME_IMAGE_PREFIX}/${crypto.randomUUID()}.${image.extension}`;
    imageFilename = image.safeName;
    imageContentType = image.contentType;
    imageSizeBytes = file.size;
    await c.env.MERLIN_FILES.put(imageKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" },
    });
  }

  if (!imageUrl && !imageKey) throw new HTTPException(400, { message: "Selecione uma imagem automatica ou envie uma imagem personalizada." });
  return { imageUrl, imageKey, imageFilename, imageContentType, imageSizeBytes, oldImageKey };
}

export async function createHomeContent(c: AppContext, input: HomeContentInput, file?: File | null) {
  const normalized = normalizeInput(input);
  if (normalized.slotType !== "hero") throw new HTTPException(400, { message: "Somente slides do carrossel podem ser adicionados." });
  const image = await prepareImage(c, normalized, file);
  const now = new Date().toISOString();
  try {
    const result = await c.env.merlin_db.prepare(`
      INSERT INTO home_content_items (
        slot_type, position, app_id, title, description, secondary_text, display_label,
        image_mode, image_url, image_key, image_filename, image_content_type, image_size_bytes,
        image_position_x, image_position_y, image_zoom, primary_action, secondary_action, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      normalized.slotType, normalized.position, normalized.appId, normalized.title, normalized.description,
      normalized.secondaryText, normalized.displayLabel, normalized.imageMode, image.imageUrl, image.imageKey,
      image.imageFilename, image.imageContentType, image.imageSizeBytes, normalized.imagePositionX,
      normalized.imagePositionY, normalized.imageZoom, normalized.primaryAction, normalized.secondaryAction, normalized.enabled ? 1 : 0, now, now
    ).run();
    return mapRow(await getRow(c, Number(result.meta.last_row_id)));
  } catch (error) {
    if (image.imageKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(image.imageKey).catch(() => undefined);
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "Ja existe conteudo nesta posicao." });
    throw error;
  }
}

export async function updateHomeContent(c: AppContext, value: string | number, input: HomeContentInput, file?: File | null) {
  const existing = await getRow(c, value);
  const normalized = normalizeInput(input, existing.slot_type);
  const image = await prepareImage(c, normalized, file, existing);
  try {
    await c.env.merlin_db.prepare(`
      UPDATE home_content_items SET position = ?, app_id = ?, title = ?, description = ?, secondary_text = ?, display_label = ?,
        image_mode = ?, image_url = ?, image_key = ?, image_filename = ?, image_content_type = ?, image_size_bytes = ?,
        image_position_x = ?, image_position_y = ?, image_zoom = ?, primary_action = ?, secondary_action = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      normalized.position, normalized.appId, normalized.title, normalized.description, normalized.secondaryText,
      normalized.displayLabel, normalized.imageMode, image.imageUrl, image.imageKey, image.imageFilename,
      image.imageContentType, image.imageSizeBytes, normalized.imagePositionX, normalized.imagePositionY, normalized.imageZoom,
      normalized.primaryAction, normalized.secondaryAction, normalized.enabled ? 1 : 0, new Date().toISOString(), existing.id
    ).run();
  } catch (error) {
    if (image.imageKey && image.imageKey !== existing.image_key && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(image.imageKey).catch(() => undefined);
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "Ja existe conteudo nesta posicao." });
    throw error;
  }
  if (image.oldImageKey && image.oldImageKey !== image.imageKey && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(image.oldImageKey).catch(() => undefined);
  return mapRow(await getRow(c, existing.id));
}

export async function deleteHomeContent(c: AppContext, value: string | number) {
  const row = await getRow(c, value);
  if (row.slot_type !== "hero") throw new HTTPException(400, { message: "Cards fixos devem ser desativados, nao excluidos." });
  await c.env.merlin_db.prepare("DELETE FROM home_content_items WHERE id = ?").bind(row.id).run();
  if (row.image_key && c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(row.image_key).catch(() => undefined);
  if (c.env.MERLIN_FILES) await c.env.MERLIN_FILES.delete(`${HOME_REMOTE_IMAGE_CACHE_PREFIX}/${row.id}`).catch(() => undefined);
  return { success: true, id: row.id };
}

export async function reorderHomeContent(c: AppContext, slotTypeValue: string, itemIds: number[]) {
  const slotType = normalizeSlotType(slotTypeValue);
  const ids = itemIds.map(normalizeId);
  if (!ids.length || new Set(ids).size !== ids.length || ids.length > SLOT_LIMITS[slotType]) {
    throw new HTTPException(400, { message: "Ordem da Home invalida." });
  }
  const rows = await c.env.merlin_db.prepare("SELECT id FROM home_content_items WHERE slot_type = ? ORDER BY position, id").bind(slotType).all<{ id: number }>();
  const existingIds = (rows.results || []).map((row) => row.id);
  if (existingIds.length !== ids.length || existingIds.some((id) => !ids.includes(id))) {
    throw new HTTPException(400, { message: "A reordenacao deve incluir todos os itens do slot." });
  }
  const now = new Date().toISOString();
  const temporary = ids.map((id, index) => c.env.merlin_db.prepare("UPDATE home_content_items SET position = ?, updated_at = ? WHERE id = ?").bind(1001 + index, now, id));
  const final = ids.map((id, index) => c.env.merlin_db.prepare("UPDATE home_content_items SET position = ?, updated_at = ? WHERE id = ?").bind(index + 1, now, id));
  await c.env.merlin_db.batch([...temporary, ...final]);
  return listHomeContent(c, true);
}

export async function getHomeContentImage(c: AppContext, value: string | number) {
  const row = await getRow(c, value);
  if (row.image_key) {
    if (!c.env.MERLIN_FILES) throw new HTTPException(404, { message: "Imagem nao encontrada." });
    const object = await c.env.MERLIN_FILES.get(row.image_key);
    if (!object) throw new HTTPException(404, { message: "Imagem nao encontrada." });
    return { kind: "r2" as const, object };
  }
  if (!row.image_url) throw new HTTPException(404, { message: "Imagem nao encontrada." });
  const cacheKey = `${HOME_REMOTE_IMAGE_CACHE_PREFIX}/${row.id}`;
  if (c.env.MERLIN_FILES) {
    try {
      const cached = await c.env.MERLIN_FILES.get(cacheKey);
      if (cached?.customMetadata?.revision === row.updated_at) return { kind: "r2" as const, object: cached };
      await cached?.body?.cancel();
    } catch (error) {
      console.warn("[home] image cache read failed", { itemId: row.id, error: String(error) });
    }
  }

  const urls = [row.image_url];
  if (row.image_mode === "steam" && row.app_id && /^\d+$/.test(row.app_id)) {
    urls.push(
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${row.app_id}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${row.app_id}/header.jpg`,
    );
  }
  const failures: string[] = [];
  for (const url of [...new Set(urls)]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "image/*", "User-Agent": "Merlin/2.0" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (!response.ok || !response.body || !ALLOWED_IMAGE_TYPES.has(contentType)
        || contentLength > MAX_HOME_IMAGE_BYTES) {
        failures.push(`${originLabel(url)}:${response.status}`);
        await response.body?.cancel();
        continue;
      }
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_HOME_IMAGE_BYTES) {
        failures.push(`${originLabel(url)}:invalid_size`);
        continue;
      }
      if (c.env.MERLIN_FILES) {
        try {
          await c.env.MERLIN_FILES.put(cacheKey, bytes, {
            httpMetadata: { contentType },
            customMetadata: { revision: row.updated_at },
          });
        } catch (error) {
          console.warn("[home] image cache write failed", { itemId: row.id, error: String(error) });
        }
      }
      if (failures.length) console.info("[home] alternate image origin used", { itemId: row.id, attempts: failures.length });
      return { kind: "remote" as const, response: new Response(bytes, { headers: { "Content-Type": contentType } }) };
    } catch (error) {
      failures.push(`${originLabel(url)}:${controller.signal.aborted ? "timeout" : "request_failed"}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  console.warn("[home] image origins unavailable", { itemId: row.id, appId: row.app_id, attempts: failures });
  throw new HTTPException(502, { message: "Imagem remota indisponivel." });
}
