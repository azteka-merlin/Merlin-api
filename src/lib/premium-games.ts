import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "./auth";
import type { AppContext } from "../types";

type PremiumGameMetadata = {
  name: string | null;
  coverUrl: string | null;
};

type SteamAppDetailsResponse = Record<string, {
  success?: boolean;
  data?: {
    type?: string;
    name?: string;
    header_image?: string;
    capsule_image?: string;
  };
}>;

type FallbackCatalogEntry = {
  appid?: string | number;
  name?: string;
  capsule_image?: string;
  header_image?: string;
};

type PremiumActivationStatus = "reserved" | "active" | "expired" | "failed";
type PremiumActivationType = "steam_ticket" | "third_party";

type ViewerLicenseLookup = {
  id: number;
  license_key: string;
  name: string;
  hwid: string | null;
  expires_at: string;
  status: "active" | "revoked";
};

type PremiumActivationRecord = {
  id: number;
  license_id: number;
  app_id: string;
  status: PremiumActivationStatus;
  reserved_at: string | null;
  activated_at: string | null;
  cooldown_until: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PremiumGameRecord = {
  id: number;
  app_id: string;
  name: string;
  cover_url: string | null;
  archive_key: string;
  install_subpath: string | null;
  activation_type: PremiumActivationType | null;
  launch_executable_path: string | null;
  activation_limit: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type PremiumGame = {
  id: number;
  appId: string;
  name: string;
  coverUrl: string | null;
  archiveKey: string;
  installSubpath: string | null;
  activationType: PremiumActivationType;
  launchExecutablePath: string | null;
  activationLimit: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthenticatedPremiumLicense = {
  id: number;
  licenseKey: string;
  name: string;
  hwid: string;
  expiresAt: string;
};

export type PremiumCatalogItem = {
  id: number;
  appId: string;
  name: string;
  coverUrl: string | null;
  installSubpath: string | null;
  activationType: PremiumActivationType;
  launchExecutablePath: string | null;
  activationLimit: number;
  enabled: boolean;
  archiveAvailable: boolean;
  availability: {
    activeCount: number;
    reservedCount: number;
    occupiedSlots: number;
    availableSlots: number;
    nextSlotAt: string | null;
    cooldownEntries: Array<{
      availableAt: string;
      kind: "cooldown" | "reserved";
    }>;
  };
  viewer: {
    status: "available" | "cooldown" | "reserved" | "unavailable";
    canActivate: boolean;
    cooldownUntil: string | null;
    reservedUntil: string | null;
    lastActivatedAt: string | null;
  };
};

export type PremiumReservationResult = {
  reservationId: number;
  game: PremiumGame;
  archiveAvailable: boolean;
};

export type PremiumActivationCompletion = {
  activatedAt: string;
  cooldownUntil: string;
};

export type PremiumGameCreateInput = {
  appId: string;
  name?: string | null;
  coverUrl?: string | null;
  archiveKey?: string | null;
  installSubpath?: string | null;
  activationType?: PremiumActivationType | null;
  launchExecutablePath?: string | null;
  activationLimit?: number | null;
  enabled?: boolean | null;
};

export type PremiumGameUpdateInput = {
  name?: string | null;
  coverUrl?: string | null;
  archiveKey?: string | null;
  installSubpath?: string | null;
  activationType?: PremiumActivationType | null;
  launchExecutablePath?: string | null;
  activationLimit?: number | null;
  enabled?: boolean | null;
};

const USER_AGENT = "Merlin/2.0";
const STEAM_APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const FALLBACK_GAMES_CATALOG_URL = "https://generator.ryuu.lol/files/games.json";
const METADATA_TIMEOUT_MS = 3000;
const PREMIUM_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PREMIUM_RESERVATION_TIMEOUT_MS = 3 * 60 * 1000;

function normalizeAppId(appId: string): string {
  const normalized = String(appId || "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new HTTPException(400, { message: "Invalid appId" });
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function buildDefaultName(appId: string): string {
  return `App ${appId}`;
}

function buildDefaultArchiveKey(appId: string): string {
  return `${appId}/${appId}.zip`;
}

function normalizeArchiveKey(appId: string, archiveKey?: string | null): string {
  const normalized = normalizeOptionalText(archiveKey) || buildDefaultArchiveKey(appId);
  if (normalized.includes("..") || normalized.includes("\\") || normalized.startsWith("/")) {
    throw new HTTPException(400, { message: "Invalid archive key" });
  }
  return normalized;
}

function normalizeInstallSubpath(installSubpath?: string | null): string | null {
  const normalized = normalizeOptionalText(installSubpath);
  if (!normalized) {
    return null;
  }

  const slashNormalized = normalized.replace(/\\/g, "/");
  const segments = slashNormalized.split("/");
  if (
    slashNormalized.startsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new HTTPException(400, { message: "Invalid install subpath" });
  }

  return segments.join("/");
}

function normalizeRelativeExecutablePath(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  const slashNormalized = normalized.replace(/\\/g, "/");
  const segments = slashNormalized.split("/");
  if (
    slashNormalized.startsWith("/")
    || /^[a-zA-Z]:/.test(slashNormalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || !segments[segments.length - 1]?.toLowerCase().endsWith(".exe")
  ) {
    throw new HTTPException(400, { message: "Invalid launch executable path" });
  }

  return segments.join("/");
}

function normalizeActivationType(value?: PremiumActivationType | null): PremiumActivationType {
  return value === "third_party" ? "third_party" : "steam_ticket";
}

function normalizeActivationLimit(value: number | null | undefined): number {
  const limit = value ?? 5;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new HTTPException(400, { message: "Invalid activation limit" });
  }
  return limit;
}

function parseBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

function mapPremiumGame(row: PremiumGameRecord): PremiumGame {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    coverUrl: row.cover_url,
    archiveKey: row.archive_key,
    installSubpath: row.install_subpath,
    activationType: normalizeActivationType(row.activation_type),
    launchExecutablePath: row.launch_executable_path,
    activationLimit: row.activation_limit,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getReservedUntil(record: PremiumActivationRecord): string | null {
  if (!record.reserved_at) return null;

  const reservedAt = new Date(record.reserved_at);
  if (Number.isNaN(reservedAt.getTime())) {
    return null;
  }

  return new Date(reservedAt.getTime() + PREMIUM_RESERVATION_TIMEOUT_MS).toISOString();
}

function isActiveActivation(record: PremiumActivationRecord, nowIso: string): boolean {
  return record.status === "active" && Boolean(record.cooldown_until) && String(record.cooldown_until) > nowIso;
}

function isReservedActivation(record: PremiumActivationRecord, nowIso: string): boolean {
  const reservedUntil = getReservedUntil(record);
  return record.status === "reserved" && Boolean(reservedUntil) && String(reservedUntil) > nowIso;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = METADATA_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchSteamMetadata(appId: string): Promise<PremiumGameMetadata | null> {
  try {
    const url = new URL(STEAM_APPDETAILS_URL);
    url.searchParams.set("appids", appId);
    url.searchParams.set("filters", "basic");

    const response = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    const payload = await response.json() as SteamAppDetailsResponse;
    const details = payload?.[appId];
    const data = details?.success === true ? details.data : null;
    if (!data) {
      return null;
    }

    const type = typeof data.type === "string" ? data.type.trim().toLowerCase() : "";
    if (type && type !== "game") {
      return null;
    }

    const name = typeof data.name === "string" ? data.name.trim() : "";
    const capsuleImage = typeof data.capsule_image === "string" ? data.capsule_image.trim() : "";
    const headerImage = typeof data.header_image === "string" ? data.header_image.trim() : "";

    return {
      name: name || null,
      coverUrl: capsuleImage || headerImage || null,
    };
  } catch (error) {
    console.warn("[premium-games] steam metadata lookup failed:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

async function fetchFallbackCatalogMetadata(appId: string): Promise<PremiumGameMetadata | null> {
  try {
    const response = await fetchWithTimeout(FALLBACK_GAMES_CATALOG_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    const entry = payload.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }

      return String((candidate as FallbackCatalogEntry).appid || "").trim() === appId;
    }) as FallbackCatalogEntry | undefined;

    if (!entry) {
      return null;
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const capsuleImage = typeof entry.capsule_image === "string" ? entry.capsule_image.trim() : "";
    const headerImage = typeof entry.header_image === "string" ? entry.header_image.trim() : "";

    return {
      name: name || null,
      coverUrl: capsuleImage || headerImage || null,
    };
  } catch (error) {
    console.warn("[premium-games] fallback catalog metadata lookup failed:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

async function resolvePremiumGameMetadata(appId: string): Promise<PremiumGameMetadata> {
  const steamMetadata = await fetchSteamMetadata(appId);
  if (steamMetadata?.name || steamMetadata?.coverUrl) {
    return steamMetadata;
  }

  const fallbackMetadata = await fetchFallbackCatalogMetadata(appId);
  if (fallbackMetadata?.name || fallbackMetadata?.coverUrl) {
    return fallbackMetadata;
  }

  return {
    name: null,
    coverUrl: null,
  };
}

async function headArchiveAvailability(c: AppContext, archiveKey: string): Promise<boolean> {
  if (!c.env.MERLIN_ACTIVATIONS) {
    return false;
  }

  const object = await c.env.MERLIN_ACTIVATIONS.head(archiveKey);
  return Boolean(object);
}

async function listCurrentPremiumActivations(c: AppContext, appIds: string[]): Promise<PremiumActivationRecord[]> {
  if (!appIds.length) {
    return [];
  }

  const placeholders = appIds.map(() => "?").join(", ");
  const result = await c.env.merlin_db
    .prepare(`
      SELECT
        id,
        license_id,
        app_id,
        status,
        reserved_at,
        activated_at,
        cooldown_until,
        failure_stage,
        failure_reason,
        created_at,
        updated_at
      FROM premium_activations
      WHERE app_id IN (${placeholders})
        AND status IN ('reserved', 'active')
    `)
    .bind(...appIds)
    .all<PremiumActivationRecord>();

  return result.results || [];
}

async function listLicensePremiumActivations(c: AppContext, licenseId: number, appId: string): Promise<PremiumActivationRecord[]> {
  const result = await c.env.merlin_db
    .prepare(`
      SELECT
        id,
        license_id,
        app_id,
        status,
        reserved_at,
        activated_at,
        cooldown_until,
        failure_stage,
        failure_reason,
        created_at,
        updated_at
      FROM premium_activations
      WHERE license_id = ?
        AND app_id = ?
        AND status IN ('reserved', 'active')
      ORDER BY id DESC
    `)
    .bind(licenseId, appId)
    .all<PremiumActivationRecord>();

  return result.results || [];
}

export async function cleanupPremiumActivations(c: AppContext, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const expiredReservationBefore = new Date(now.getTime() - PREMIUM_RESERVATION_TIMEOUT_MS).toISOString();

  await c.env.merlin_db.batch([
    c.env.merlin_db
      .prepare(`
        UPDATE premium_activations
        SET status = 'expired', updated_at = ?
        WHERE status = 'active'
          AND cooldown_until IS NOT NULL
          AND cooldown_until <= ?
      `)
      .bind(nowIso, nowIso),
    c.env.merlin_db
      .prepare(`
        UPDATE premium_activations
        SET
          status = 'failed',
          failure_stage = COALESCE(failure_stage, 'reservation_timeout'),
          failure_reason = COALESCE(failure_reason, 'Reservation expired before activation completed.'),
          updated_at = ?
        WHERE status = 'reserved'
          AND reserved_at IS NOT NULL
          AND reserved_at <= ?
      `)
      .bind(nowIso, expiredReservationBefore),
  ]);
}

export async function requireAuthenticatedPremiumLicense(c: AppContext): Promise<AuthenticatedPremiumLicense> {
  const accessToken = parseBearerToken(c.req.raw);
  if (!accessToken) {
    throw new HTTPException(401, { message: "Missing access token" });
  }

  if (!c.env.JWT_SECRET) {
    throw new HTTPException(500, { message: "JWT secret is not configured" });
  }

  const payload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HTTPException(401, { message: "Access token expired" });
  }

  const license = await c.env.merlin_db
    .prepare(`
      SELECT id, license_key, name, hwid, expires_at, status
      FROM licenses
      WHERE id = ?
      LIMIT 1
    `)
    .bind(payload.sub)
    .first<ViewerLicenseLookup>();

  if (!license) {
    throw new HTTPException(401, { message: "License not found" });
  }

  if (license.status !== "active") {
    throw new HTTPException(401, { message: "License is not active" });
  }

  if (!license.hwid || license.hwid !== payload.hwid) {
    throw new HTTPException(401, { message: "HWID mismatch" });
  }

  const expiresAt = new Date(license.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new HTTPException(401, { message: "License expired" });
  }

  return {
    id: license.id,
    licenseKey: license.license_key,
    name: license.name,
    hwid: license.hwid,
    expiresAt: license.expires_at,
  };
}

export async function listPremiumGames(c: AppContext): Promise<PremiumGame[]> {
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT id, app_id, name, cover_url, archive_key, activation_limit, enabled, created_at, updated_at,
        install_subpath,
        activation_type,
        launch_executable_path
      FROM premium_games
      ORDER BY enabled DESC, updated_at DESC, id DESC
    `)
    .all<PremiumGameRecord>();

  return (rows.results || []).map(mapPremiumGame);
}

export async function listPremiumCatalog(c: AppContext, licenseId: number): Promise<PremiumCatalogItem[]> {
  await cleanupPremiumActivations(c);

  const games = (await listPremiumGames(c)).filter((entry) => entry.enabled);
  if (!games.length) {
    return [];
  }

  const [archiveStates, activationRows] = await Promise.all([
    Promise.all(games.map((game) => headArchiveAvailability(c, game.archiveKey))),
    listCurrentPremiumActivations(c, games.map((game) => game.appId)),
  ]);

  const nowIso = new Date().toISOString();
  const rowsByAppId = new Map<string, PremiumActivationRecord[]>();
  for (const row of activationRows) {
    const existing = rowsByAppId.get(row.app_id) || [];
    existing.push(row);
    rowsByAppId.set(row.app_id, existing);
  }

  return games.map((game, index) => {
    const rows = rowsByAppId.get(game.appId) || [];
    let activeCount = 0;
    let reservedCount = 0;
    let nextSlotAt: string | null = null;
    const cooldownEntries: PremiumCatalogItem["availability"]["cooldownEntries"] = [];
    let viewerStatus: PremiumCatalogItem["viewer"]["status"] = "available";
    let cooldownUntil: string | null = null;
    let reservedUntil: string | null = null;
    let lastActivatedAt: string | null = null;

    for (const row of rows) {
      if (isActiveActivation(row, nowIso)) {
        activeCount += 1;
        if (row.cooldown_until) {
          cooldownEntries.push({
            availableAt: row.cooldown_until,
            kind: "cooldown",
          });
        }
        if (!nextSlotAt || String(row.cooldown_until) < nextSlotAt) {
          nextSlotAt = row.cooldown_until;
        }

        if (row.license_id === licenseId) {
          viewerStatus = "cooldown";
          cooldownUntil = row.cooldown_until;
          lastActivatedAt = row.activated_at || lastActivatedAt;
        }
        continue;
      }

      if (isReservedActivation(row, nowIso)) {
        reservedCount += 1;
        const rowReservedUntil = getReservedUntil(row);
        if (rowReservedUntil) {
          cooldownEntries.push({
            availableAt: rowReservedUntil,
            kind: "reserved",
          });
        }
        if (rowReservedUntil && (!nextSlotAt || rowReservedUntil < nextSlotAt)) {
          nextSlotAt = rowReservedUntil;
        }

        if (row.license_id === licenseId && viewerStatus !== "cooldown") {
          viewerStatus = "reserved";
          reservedUntil = rowReservedUntil;
        }
      }
    }

    const archiveAvailable = archiveStates[index] || false;
    const occupiedSlots = activeCount + reservedCount;
    const availableSlots = Math.max(0, game.activationLimit - occupiedSlots);

    if (viewerStatus === "available" && (!archiveAvailable || availableSlots <= 0)) {
      viewerStatus = "unavailable";
    }

    return {
      id: game.id,
      appId: game.appId,
      name: game.name,
      coverUrl: game.coverUrl,
      installSubpath: game.installSubpath,
      activationType: game.activationType,
      launchExecutablePath: game.launchExecutablePath,
      activationLimit: game.activationLimit,
      enabled: game.enabled,
      archiveAvailable,
      availability: {
        activeCount,
        reservedCount,
        occupiedSlots,
        availableSlots,
        nextSlotAt,
        cooldownEntries: cooldownEntries.sort((left, right) =>
          left.availableAt.localeCompare(right.availableAt)
        ),
      },
      viewer: {
        status: viewerStatus,
        canActivate: viewerStatus === "available",
        cooldownUntil,
        reservedUntil,
        lastActivatedAt,
      },
    };
  });
}

export async function getPremiumGame(c: AppContext, appId: string): Promise<PremiumGame | null> {
  const normalizedAppId = normalizeAppId(appId);
  const row = await c.env.merlin_db
    .prepare(`
      SELECT id, app_id, name, cover_url, archive_key, activation_limit, enabled, created_at, updated_at,
        install_subpath,
        activation_type,
        launch_executable_path
      FROM premium_games
      WHERE app_id = ?
      LIMIT 1
    `)
    .bind(normalizedAppId)
    .first<PremiumGameRecord>();

  return row ? mapPremiumGame(row) : null;
}

export async function reservePremiumActivation(c: AppContext, licenseId: number, appId: string): Promise<PremiumReservationResult> {
  await cleanupPremiumActivations(c);

  const game = await getPremiumGame(c, appId);
  if (!game || !game.enabled) {
    throw new HTTPException(404, { message: "Premium game not found" });
  }

  const archiveAvailable = await headArchiveAvailability(c, game.archiveKey);
  if (!archiveAvailable) {
    throw new HTTPException(409, { message: "Premium archive is not available for this game yet" });
  }

  const nowIso = new Date().toISOString();
  const licenseRows = await listLicensePremiumActivations(c, licenseId, game.appId);
  for (const row of licenseRows) {
    if (isActiveActivation(row, nowIso)) {
      throw new HTTPException(409, { message: `Premium activation is in cooldown until ${row.cooldown_until}` });
    }

    if (isReservedActivation(row, nowIso)) {
      const reservedUntil = getReservedUntil(row);
      throw new HTTPException(409, { message: `Premium activation is already being processed until ${reservedUntil}` });
    }
  }

  const appRows = await listCurrentPremiumActivations(c, [game.appId]);
  let occupiedSlots = 0;
  let nextSlotAt: string | null = null;
  for (const row of appRows) {
    if (isActiveActivation(row, nowIso)) {
      occupiedSlots += 1;
      if (!nextSlotAt || String(row.cooldown_until) < nextSlotAt) {
        nextSlotAt = row.cooldown_until;
      }
      continue;
    }

    if (isReservedActivation(row, nowIso)) {
      occupiedSlots += 1;
      const reservedUntil = getReservedUntil(row);
      if (reservedUntil && (!nextSlotAt || reservedUntil < nextSlotAt)) {
        nextSlotAt = reservedUntil;
      }
    }
  }

  if (occupiedSlots >= game.activationLimit) {
    throw new HTTPException(409, {
      message: nextSlotAt
        ? `No premium activation slots available right now. Next slot at ${nextSlotAt}`
        : "No premium activation slots available right now",
    });
  }

  const createdAt = new Date().toISOString();
  const insertResult = await c.env.merlin_db
    .prepare(`
      INSERT INTO premium_activations (
        license_id,
        app_id,
        status,
        reserved_at,
        activated_at,
        cooldown_until,
        failure_stage,
        failure_reason,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'reserved', ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    .bind(licenseId, game.appId, createdAt, createdAt, createdAt)
    .run();

  const reservationId = Number(insertResult.meta.last_row_id || 0);
  if (!reservationId) {
    throw new HTTPException(500, { message: "Could not reserve premium activation slot" });
  }

  return {
    reservationId,
    game,
    archiveAvailable,
  };
}

export async function failPremiumActivationReservation(
  c: AppContext,
  reservationId: number,
  stage: string,
  reason: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      UPDATE premium_activations
      SET
        status = 'failed',
        failure_stage = ?,
        failure_reason = ?,
        updated_at = ?
      WHERE id = ?
        AND status = 'reserved'
    `)
    .bind(stage, reason, nowIso, reservationId)
    .run();
}

export async function failPremiumActivationReservationForLicense(
  c: AppContext,
  reservationId: number,
  licenseId: number,
  appId: string,
  stage: string,
  reason: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      UPDATE premium_activations
      SET
        status = 'failed',
        failure_stage = ?,
        failure_reason = ?,
        updated_at = ?
      WHERE id = ?
        AND license_id = ?
        AND app_id = ?
        AND status = 'reserved'
    `)
    .bind(stage, reason, nowIso, reservationId, licenseId, normalizeAppId(appId))
    .run();
}

export async function assertPremiumActivationReservationForLicense(
  c: AppContext,
  reservationId: number,
  licenseId: number,
  appId: string,
): Promise<void> {
  await cleanupPremiumActivations(c);

  const row = await c.env.merlin_db
    .prepare(`
      SELECT id
      FROM premium_activations
      WHERE id = ?
        AND license_id = ?
        AND app_id = ?
        AND status = 'reserved'
      LIMIT 1
    `)
    .bind(reservationId, licenseId, normalizeAppId(appId))
    .first<{ id: number }>();

  if (!row) {
    throw new HTTPException(409, { message: "Premium activation reservation is not available" });
  }
}

export async function findPremiumActivationReservationForLicense(
  c: AppContext,
  licenseId: number,
  appId: string,
): Promise<number | null> {
  await cleanupPremiumActivations(c);

  const row = await c.env.merlin_db
    .prepare(`
      SELECT id
      FROM premium_activations
      WHERE license_id = ?
        AND app_id = ?
        AND status = 'reserved'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .bind(licenseId, normalizeAppId(appId))
    .first<{ id: number }>();

  return row?.id || null;
}

export async function completePremiumActivation(
  c: AppContext,
  reservationId: number,
): Promise<PremiumActivationCompletion> {
  const activatedAt = new Date();
  const activatedAtIso = activatedAt.toISOString();
  const cooldownUntilIso = new Date(activatedAt.getTime() + PREMIUM_COOLDOWN_MS).toISOString();

  await c.env.merlin_db
    .prepare(`
      UPDATE premium_activations
      SET
        status = 'active',
        activated_at = ?,
        cooldown_until = ?,
        updated_at = ?
      WHERE id = ?
        AND status = 'reserved'
    `)
    .bind(activatedAtIso, cooldownUntilIso, activatedAtIso, reservationId)
    .run();

  return {
    activatedAt: activatedAtIso,
    cooldownUntil: cooldownUntilIso,
  };
}

export async function completePremiumActivationForLicense(
  c: AppContext,
  reservationId: number,
  licenseId: number,
  appId: string,
): Promise<PremiumActivationCompletion> {
  await assertPremiumActivationReservationForLicense(c, reservationId, licenseId, appId);
  return completePremiumActivation(c, reservationId);
}

export async function assertPremiumDownloadAccess(c: AppContext, licenseId: number, appId: string): Promise<PremiumGame> {
  await cleanupPremiumActivations(c);

  const game = await getPremiumGame(c, appId);
  if (!game || !game.enabled) {
    throw new HTTPException(404, { message: "Premium game not found" });
  }

  const nowIso = new Date().toISOString();
  const rows = await listLicensePremiumActivations(c, licenseId, game.appId);
  const hasCurrentActivation = rows.some((row) => isActiveActivation(row, nowIso) || isReservedActivation(row, nowIso));
  if (!hasCurrentActivation) {
    throw new HTTPException(403, { message: "Premium activation not available for this license" });
  }

  return game;
}

export async function createPremiumGame(c: AppContext, input: PremiumGameCreateInput): Promise<PremiumGame> {
  const appId = normalizeAppId(input.appId);
  const archiveKey = normalizeArchiveKey(appId, input.archiveKey);
  const installSubpath = normalizeInstallSubpath(input.installSubpath);
  const activationType = normalizeActivationType(input.activationType);
  const launchExecutablePath = normalizeRelativeExecutablePath(input.launchExecutablePath);
  if (activationType === "third_party" && !launchExecutablePath) {
    throw new HTTPException(400, { message: "launchExecutablePath is required for third-party activations" });
  }
  const activationLimit = normalizeActivationLimit(input.activationLimit);
  const enabled = Boolean(input.enabled);
  const now = new Date().toISOString();
  const metadata = await resolvePremiumGameMetadata(appId);
  const name = normalizeOptionalText(input.name) || metadata.name || buildDefaultName(appId);
  const coverUrl = normalizeOptionalText(input.coverUrl) || metadata.coverUrl;

  try {
    await c.env.merlin_db
      .prepare(`
        INSERT INTO premium_games (
          app_id,
          name,
          cover_url,
          archive_key,
          install_subpath,
          activation_type,
          launch_executable_path,
          activation_limit,
          enabled,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        appId,
        name,
        coverUrl,
        archiveKey,
        installSubpath,
        activationType,
        launchExecutablePath,
        activationLimit,
        enabled ? 1 : 0,
        now,
        now,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message.toLowerCase().includes("unique")) {
      throw new HTTPException(409, { message: "Premium game already exists for this appId" });
    }
    throw error;
  }

  const created = await getPremiumGame(c, appId);
  if (!created) {
    throw new HTTPException(500, { message: "Failed to create premium game" });
  }

  return created;
}

export async function updatePremiumGame(c: AppContext, appId: string, input: PremiumGameUpdateInput): Promise<PremiumGame> {
  const existing = await getPremiumGame(c, appId);
  if (!existing) {
    throw new HTTPException(404, { message: "Premium game not found" });
  }

  const nextName = input.name !== undefined
    ? normalizeOptionalText(input.name) || buildDefaultName(existing.appId)
    : existing.name;
  const nextCoverUrl = input.coverUrl !== undefined
    ? normalizeOptionalText(input.coverUrl)
    : existing.coverUrl;
  const nextArchiveKey = input.archiveKey !== undefined
    ? normalizeArchiveKey(existing.appId, input.archiveKey)
    : existing.archiveKey;
  const nextInstallSubpath = input.installSubpath !== undefined
    ? normalizeInstallSubpath(input.installSubpath)
    : existing.installSubpath;
  const nextActivationType = input.activationType !== undefined
    ? normalizeActivationType(input.activationType)
    : existing.activationType;
  const nextLaunchExecutablePath = input.launchExecutablePath !== undefined
    ? normalizeRelativeExecutablePath(input.launchExecutablePath)
    : existing.launchExecutablePath;
  if (nextActivationType === "third_party" && !nextLaunchExecutablePath) {
    throw new HTTPException(400, { message: "launchExecutablePath is required for third-party activations" });
  }
  const nextActivationLimit = input.activationLimit !== undefined
    ? normalizeActivationLimit(input.activationLimit)
    : existing.activationLimit;
  const nextEnabled = input.enabled !== undefined
    ? Boolean(input.enabled)
    : existing.enabled;
  const now = new Date().toISOString();

  await c.env.merlin_db
    .prepare(`
      UPDATE premium_games
      SET
        name = ?,
        cover_url = ?,
        archive_key = ?,
        install_subpath = ?,
        activation_type = ?,
        launch_executable_path = ?,
        activation_limit = ?,
        enabled = ?,
        updated_at = ?
      WHERE app_id = ?
    `)
    .bind(
      nextName,
      nextCoverUrl,
      nextArchiveKey,
      nextInstallSubpath,
      nextActivationType,
      nextLaunchExecutablePath,
      nextActivationLimit,
      nextEnabled ? 1 : 0,
      now,
      existing.appId,
    )
    .run();

  const updated = await getPremiumGame(c, existing.appId);
  if (!updated) {
    throw new HTTPException(500, { message: "Failed to update premium game" });
  }

  return updated;
}

export async function deletePremiumGame(c: AppContext, appId: string): Promise<boolean> {
  const normalizedAppId = normalizeAppId(appId);
  const result = await c.env.merlin_db
    .prepare(`DELETE FROM premium_games WHERE app_id = ?`)
    .bind(normalizedAppId)
    .run();

  return Number(result.meta.changes || 0) > 0;
}
