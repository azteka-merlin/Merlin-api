import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";
import { requireGoldLauncherLicense, type LauncherLicense } from "./launcher-auth";

export const CUSTOM_GAME_DOWNLOAD_LEASE_MS = 24 * 60 * 60 * 1000;
export const CUSTOM_GAME_VERSION_GRACE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_LEASE_MS = 15 * 60 * 1000;
const PROTOCOL_HEADER = "x-merlin-custom-games-protocol";

export type GamePackageVersion = {
  id: string; archiveKey: string; packageType: "zip" | "folder"; archiveSize: number;
  executablePath: string | null; origin: "native" | "port"; protectedPaths: string[];
  status: "active" | "retired" | "deleting" | "deleted"; legacyHold: boolean;
  createdAt: string; retiredAt: string | null; deleteAfter: string | null;
};

export type VersionGameInput = {
  id: string; archiveKey?: string; archive_key?: string; packageType?: "zip" | "folder"; package_type?: "zip" | "folder";
  archiveSize?: number; archive_size?: number; executablePath?: string | null; executable_path?: string | null;
  origin?: "native" | "port"; protectedPaths?: string[]; protected_paths_json?: string;
  published?: number | boolean; installName?: string; install_name?: string;
};

type VersionRow = {
  game_id: string; archive_key: string; package_type: "zip" | "folder"; archive_size: number;
  executable_path: string | null; origin: "native" | "port"; protected_paths_json: string;
  created_at: string; retired_at: string | null; delete_after: string | null;
  status: GamePackageVersion["status"]; legacy_hold: number;
};

type DownloadSessionRow = {
  id: string; game_id: string; archive_key: string; license_id: number; expires_at: string;
  completed_at: string | null; created_at: string;
};

function fail(status: 400 | 404 | 409 | 426, code: string, message: string): never {
  throw Object.assign(new HTTPException(status, { message }), { code });
}

function protection(value: unknown, origin: "native" | "port"): string[] {
  let paths: unknown = value;
  if (typeof paths === "string") { try { paths = JSON.parse(paths); } catch { paths = []; } }
  const result = origin === "port" ? ["game"] : [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path === "string" && path && !result.some(item => item.toLowerCase() === path.toLowerCase())) result.push(path);
  }
  return result;
}

function rowVersion(row: VersionRow): GamePackageVersion {
  const origin = row.origin === "port" ? "port" : "native";
  return {
    id: row.game_id, archiveKey: row.archive_key, packageType: row.package_type, archiveSize: row.archive_size,
    executablePath: row.executable_path, origin, protectedPaths: protection(row.protected_paths_json, origin),
    status: row.status, legacyHold: Boolean(row.legacy_hold),
    createdAt: row.created_at, retiredAt: row.retired_at, deleteAfter: row.delete_after,
  };
}

function inputVersion(game: VersionGameInput) {
  const origin = game.origin === "port" ? "port" : "native";
  const archiveKey = game.archiveKey ?? game.archive_key ?? "";
  if (!archiveKey || archiveKey.startsWith("draft/")) fail(400, "game_package_missing", "O jogo ainda não tem pacote publicado.");
  return {
    id: game.id, archiveKey, packageType: game.packageType ?? game.package_type ?? "zip",
    archiveSize: game.archiveSize ?? game.archive_size ?? 0,
    executablePath: game.executablePath ?? game.executable_path ?? null,
    origin, protectedPaths: protection(game.protectedPaths ?? game.protected_paths_json, origin),
  };
}

function mergeVersion<T extends VersionGameInput>(game: T, version: GamePackageVersion): T & GamePackageVersion {
  return {
    ...game, ...version,
    // Existing package handlers use database column names; keep them pinned too.
    archive_key: version.archiveKey, package_type: version.packageType, archive_size: version.archiveSize,
    executable_path: version.executablePath, protected_paths_json: JSON.stringify(version.protectedPaths),
  };
}

export function gameVersionInsertStatement(env: AppBindings, game: VersionGameInput,
  options: { legacyHold?: boolean; now?: string } = {}): D1PreparedStatement {
  const version = inputVersion(game);
  return env.merlin_db.prepare(`INSERT OR IGNORE INTO custom_game_versions
    (game_id,archive_key,package_type,archive_size,executable_path,origin,protected_paths_json,
      created_at,retired_at,delete_after,status,legacy_hold)
    SELECT ?,?,?,?,?,?,?,?,NULL,NULL,'active',
      CASE WHEN ?=1 AND NOT EXISTS (SELECT 1 FROM custom_game_versions WHERE game_id=? AND legacy_hold=1) THEN 1 ELSE 0 END`)
    .bind(version.id, version.archiveKey, version.packageType, version.archiveSize, version.executablePath,
      version.origin, JSON.stringify(version.protectedPaths), options.now || new Date().toISOString(),
      options.legacyHold === false ? 0 : 1, version.id);
}

export function retireGameVersionStatement(env: AppBindings, gameId: string, archiveKey: string,
  options: { now?: string } = {}): D1PreparedStatement {
  const now = options.now || new Date().toISOString();
  const deleteAfter = new Date(Date.parse(now) + CUSTOM_GAME_VERSION_GRACE_MS).toISOString();
  return env.merlin_db.prepare(`UPDATE custom_game_versions SET status='retired',retired_at=?,delete_after=?
    WHERE game_id=? AND archive_key=? AND status='active'`).bind(now, deleteAfter, gameId, archiveKey);
}

export async function findGameVersion(env: AppBindings, gameId: string, archiveKey: string): Promise<GamePackageVersion | null> {
  const row = await env.merlin_db.prepare("SELECT * FROM custom_game_versions WHERE game_id=? AND archive_key=? LIMIT 1")
    .bind(gameId, archiveKey).first<VersionRow>();
  return row ? rowVersion(row) : null;
}

export async function ensureGameVersion(env: AppBindings, game: VersionGameInput,
  options: { legacyHold?: boolean } = {}): Promise<GamePackageVersion> {
  await gameVersionInsertStatement(env, game, options).run();
  const version = await findGameVersion(env, game.id, inputVersion(game).archiveKey);
  if (!version) fail(409, "game_version_unavailable", "A versão do jogo não está disponível.");
  return version;
}

export async function getLegacyGamePackage<T extends VersionGameInput>(env: AppBindings, game: T): Promise<T & GamePackageVersion> {
  let row = await env.merlin_db.prepare(`SELECT * FROM custom_game_versions
    WHERE game_id=? AND legacy_hold=1 AND status IN ('active','retired') ORDER BY created_at LIMIT 1`)
    .bind(game.id).first<VersionRow>();
  if (!row) {
    await ensureGameVersion(env, game);
    row = await env.merlin_db.prepare(`SELECT * FROM custom_game_versions
      WHERE game_id=? AND legacy_hold=1 AND status IN ('active','retired') ORDER BY created_at LIMIT 1`)
      .bind(game.id).first<VersionRow>();
  }
  if (!row) fail(409, "legacy_game_version_unavailable", "Atualize o Merlin para baixar a versão atual deste jogo.");
  return mergeVersion(game, rowVersion(row));
}

export function supportsGameVersionProtocol(c: AppContext): boolean { return c.req.header(PROTOCOL_HEADER) === "2"; }

function availableVersion(version: GamePackageVersion | null): GamePackageVersion {
  if (!version) fail(404, "game_version_not_found", "Esta versão do jogo não foi encontrada.");
  if (version.status !== "active" && version.status !== "retired") {
    fail(409, "game_version_unavailable", "Esta versão do jogo não está mais disponível. Atualize o catálogo para baixar a versão nova.");
  }
  return version;
}

async function renewSession(env: AppBindings, gameId: string, leaseId: string, archiveKey: string, licenseId: number) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CUSTOM_GAME_DOWNLOAD_LEASE_MS).toISOString();
  const result = await env.merlin_db.prepare(`UPDATE custom_game_download_sessions SET expires_at=?
    WHERE id=? AND game_id=? AND archive_key=? AND license_id=? AND completed_at IS NULL AND expires_at>?
      AND EXISTS (SELECT 1 FROM custom_game_versions v WHERE v.game_id=custom_game_download_sessions.game_id
        AND v.archive_key=custom_game_download_sessions.archive_key AND v.status IN ('active','retired'))`)
    .bind(expiresAt, leaseId, gameId, archiveKey, licenseId, now).run();
  if (!result.meta.changes) fail(409, "game_download_session_expired", "A sessão de download expirou ou foi encerrada. Inicie uma nova sessão para retomar esta versão.");
  return expiresAt;
}

export async function resolveGamePackage<T extends VersionGameInput>(c: AppContext, game: T,
  license: Pick<LauncherLicense, "id">, options: { requireSession?: boolean } = {}): Promise<T & GamePackageVersion> {
  const archiveKey = c.req.query("archiveKey");
  const leaseId = c.req.query("downloadSessionId");
  if (!supportsGameVersionProtocol(c)) {
    if (archiveKey || leaseId) fail(426, "custom_game_protocol_required", "Atualize o Merlin para usar downloads por versão.");
    return getLegacyGamePackage(c.env, game);
  }
  if (options.requireSession !== false && (!archiveKey || !leaseId)) {
    fail(409, "game_download_session_required", "Inicie uma sessão de download para fixar a versão do jogo.");
  }
  const currentKey = game.archiveKey ?? game.archive_key;
  if (!archiveKey || archiveKey === currentKey) await ensureGameVersion(c.env, game);
  const version = availableVersion(await findGameVersion(c.env, game.id, archiveKey || currentKey || ""));
  if (leaseId) await renewSession(c.env, game.id, leaseId, version.archiveKey, license.id);
  return mergeVersion(game, version);
}

export function registerGameVersionRoutes(app: Hono<{ Bindings: AppBindings }>, deps: {
  findGame: (c: AppContext, id: string) => Promise<VersionGameInput | null>;
}) {
  app.post("/api/custom-games/:id/download-session", async c => {
    const license = await requireGoldLauncherLicense(c);
    if (!supportsGameVersionProtocol(c)) fail(426, "custom_game_protocol_required", "Atualize o Merlin para usar downloads por versão.");
    const game = await deps.findGame(c, c.req.param("id"));
    if (!game || !game.published) fail(404, "game_not_found", "Jogo não encontrado.");
    let body: { archiveKey?: unknown };
    try { body = await c.req.json(); } catch { fail(400, "invalid_download_session", "Informe a versão do pacote para iniciar o download."); }
    if (!body || typeof body.archiveKey !== "string" || !body.archiveKey || body.archiveKey.length > 512) {
      fail(400, "invalid_download_session", "Informe a versão do pacote para iniciar o download.");
    }
    const key = body.archiveKey;
    if (key === (game.archiveKey ?? game.archive_key)) await ensureGameVersion(c.env, game);
    const version = availableVersion(await findGameVersion(c.env, game.id, key));
    const leaseId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CUSTOM_GAME_DOWNLOAD_LEASE_MS).toISOString();
    // This insert and the cleanup claim each observe the other atomically in D1.
    const result = await c.env.merlin_db.prepare(`INSERT INTO custom_game_download_sessions
      (id,game_id,archive_key,license_id,expires_at,completed_at,created_at)
      SELECT ?,game_id,archive_key,?,?,NULL,? FROM custom_game_versions
      WHERE game_id=? AND archive_key=? AND status IN ('active','retired')`)
      .bind(leaseId, license.id, expiresAt, now, game.id, key).run();
    if (!result.meta.changes) fail(409, "game_version_unavailable", "Esta versão está sendo removida. Atualize o catálogo para baixar a versão nova.");
    return c.json({ success: true, leaseId, archiveKey: key, expiresAt, heartbeatSeconds: 60,
      packageType: version.packageType, archiveSize: version.archiveSize, executablePath: version.executablePath,
      origin: version.origin, protectedPaths: version.protectedPaths,
      installName: game.installName ?? game.install_name ?? "" });
  });

  for (const action of ["heartbeat", "complete", "cancel"] as const) {
    app.post(`/api/custom-games/:id/download-session/:leaseId/${action}`, async c => {
      const license = await requireGoldLauncherLicense(c);
      const leaseId = c.req.param("leaseId")!;
      const gameId = c.req.param("id")!;
      const session = await c.env.merlin_db.prepare(`SELECT * FROM custom_game_download_sessions
        WHERE id=? AND game_id=? AND license_id=? LIMIT 1`).bind(leaseId, gameId, license.id).first<DownloadSessionRow>();
      if (!session) fail(404, "game_download_session_not_found", "Sessão de download não encontrada.");
      if (action === "heartbeat") {
        const game = await deps.findGame(c, gameId);
        if (!game) fail(404, "game_not_found", "Jogo não encontrado.");
        const expiresAt = await renewSession(c.env, gameId, leaseId, session.archive_key, license.id);
        return c.json({ success: true, leaseId, archiveKey: session.archive_key, expiresAt, heartbeatSeconds: 60 });
      }
      const now = new Date().toISOString();
      await c.env.merlin_db.prepare(`UPDATE custom_game_download_sessions
        SET completed_at=COALESCE(completed_at,?),expires_at=MIN(expires_at,?) WHERE id=? AND game_id=? AND license_id=?`)
        .bind(now, now, leaseId, gameId, license.id).run();
      return c.json({ success: true });
    });
  }
}

export async function cleanupRetiredGameVersions(env: AppBindings,
  deletePackage: (version: GamePackageVersion) => Promise<void>,
  options: { canDelete?: (version: GamePackageVersion) => Promise<boolean>; limit?: number } = {}) {
  const counts = { deleted: 0, skipped: 0, failed: 0 };
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(25, Math.floor(options.limit || 10)));
  const candidates = await env.merlin_db.prepare(`SELECT * FROM custom_game_versions
    WHERE legacy_hold=0 AND status IN ('retired','deleting') AND delete_after<=? ORDER BY delete_after LIMIT ?`)
    .bind(now, limit).all<VersionRow>();
  for (const row of candidates.results) {
    const version = rowVersion(row);
    try {
      // The caller materializes the integrity sidecar before any package is removed.
      if (!options.canDelete || !await options.canDelete(version)) { counts.skipped++; continue; }
      const retryAt = new Date(Date.now() + CLEANUP_LEASE_MS).toISOString();
      const claim = await env.merlin_db.prepare(`UPDATE custom_game_versions SET status='deleting',delete_after=?
        WHERE game_id=? AND archive_key=? AND legacy_hold=0 AND status IN ('retired','deleting') AND delete_after<=?
          AND NOT EXISTS (SELECT 1 FROM custom_games g
            WHERE g.archive_key=custom_game_versions.archive_key AND g.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM custom_game_download_sessions s
            WHERE s.archive_key=custom_game_versions.archive_key AND s.completed_at IS NULL AND s.expires_at>?)
          AND NOT EXISTS (SELECT 1 FROM custom_game_versions baseline
            WHERE baseline.archive_key=custom_game_versions.archive_key AND baseline.legacy_hold=1
              AND baseline.status IN ('active','retired'))`)
        .bind(retryAt, version.id, version.archiveKey, now, now).run();
      if (!claim.meta.changes) { counts.skipped++; continue; }
      // Publication is blocked while a version is deleting. Bumping the revision
      // also invalidates a publish whose storage preflight happened before this
      // cleanup, even if its transaction arrives after deletion has completed.
      await env.merlin_db.prepare(`UPDATE custom_games SET storage_revision=storage_revision+1
        WHERE id=? AND deleted_at IS NULL`).bind(version.id).run();
      await deletePackage(version);
      await env.merlin_db.prepare(`UPDATE custom_game_versions SET status='deleted' WHERE game_id=? AND archive_key=?
        AND status='deleting' AND delete_after=?`).bind(version.id, version.archiveKey, retryAt).run();
      counts.deleted++;
    } catch { counts.failed++; }
  }
  return counts;
}
