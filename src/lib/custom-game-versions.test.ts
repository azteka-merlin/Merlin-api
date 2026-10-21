import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { Hono } from "hono";
import type { AppBindings, AppContext } from "../types";
import { requireGoldLauncherLicense } from "./launcher-auth";
import { cleanupRetiredGameVersions, ensureGameVersion, findGameVersion, gameVersionInsertStatement,
  getLegacyGamePackage, registerGameVersionRoutes, resolveGamePackage, retireGameVersionStatement } from "./custom-game-versions";

vi.mock("./launcher-auth", () => ({ requireGoldLauncherLicense: vi.fn() }));

const gameId = "11111111-1111-4111-8111-111111111111";
const keys = ["archives/11111111-1111-4111-8111-111111111111.zip", "archives/22222222-2222-4222-8222-222222222222.zip", "archives/33333333-3333-4333-8333-333333333333.zip"];
const protocol = { "x-merlin-custom-games-protocol": "2", "content-type": "application/json" };
const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0082_custom_games.sql", "0083_custom_games_folder_packages.sql"]) {
    db.exec(readFileSync(new NodeURL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  db.prepare(`INSERT INTO custom_games (id,name,install_name,admin_note,image_key,archive_key,archive_size,executable_path,published)
    VALUES (?,?,?,'','image',?,100,'Old.exe',1)`).run(gameId, "Test game", "Test game", keys[0]!);
  db.exec(readFileSync(new NodeURL("../../migrations/0085_custom_game_versions.sql", import.meta.url), "utf8"));
  const game = { id: gameId, archive_key: keys[0]!, archive_size: 100, package_type: "zip" as "zip" | "folder",
    executable_path: "Old.exe", origin: "native" as "native" | "port", protected_paths_json: "[]", published: 1, install_name: "Test game" };
  const hooks = { beforeRun: undefined as undefined | ((sql: string, values: unknown[]) => void) };
  function prepare(sql: string) {
    let values: unknown[] = [];
    const prepared = {
      bind(...next: unknown[]) { values = next; return prepared; },
      async first<T>() { return (db.prepare(sql).get(...values as []) || null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...values as []) as T[] }; },
      async run() { hooks.beforeRun?.(sql, values); return { meta: { changes: Number(db.prepare(sql).run(...values as []).changes) } }; },
    };
    return prepared;
  }
  const env = { merlin_db: { prepare } } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>();
  registerGameVersionRoutes(app, { findGame: async (_c, id) => id === game.id ? game : null });
  app.get("/resolve", async c => c.json(await resolveGamePackage(c, game, { id: 132 })));
  app.get("/inspect", async c => c.json(await resolveGamePackage(c, game, { id: 132 }, { requireSession: false })));
  app.onError((error, c) => c.json({ error: error.message, code: (error as { code?: string }).code }, (error as { status?: number }).status as 400 || 500));
  async function request(route = "", body?: unknown, headers: Record<string, string> = protocol) {
    const response = await app.request(`http://localhost/api/custom-games/${gameId}/download-session${route}`, {
      method: "POST", headers, ...(body ? { body: JSON.stringify(body) } : {}),
    }, env);
    return { response, body: await response.json() as any };
  }
  async function publish(index: number, extra: Partial<typeof game> = {}) {
    const priorKey = game.archive_key;
    Object.assign(game, { archive_key: keys[index]!, archive_size: 100 * (index + 1), executable_path: `Version${index + 1}.exe` }, extra);
    await ensureGameVersion(env, game);
    db.prepare("UPDATE custom_games SET archive_key=?,archive_size=?,executable_path=? WHERE id=?").run(game.archive_key, game.archive_size, game.executable_path, game.id);
    await retireGameVersionStatement(env, game.id, priorKey, { now: oldTime }).run();
  }
  return { db, env, app, game, request, publish, hooks };
}

beforeEach(() => {
  vi.mocked(requireGoldLauncherLicense).mockResolvedValue({ id: 132, planTier: "ouro" } as Awaited<ReturnType<typeof requireGoldLauncherLicense>>);
});

describe("custom game package snapshots and legacy clients", () => {
  it("migration preserves the initial package as the permanent legacy baseline", async () => {
    const h = harness();
    await h.publish(1);
    const legacy = await getLegacyGamePackage(h.env, h.game);
    expect(legacy.archiveKey).toBe(keys[0]);
    expect(legacy.archive_key).toBe(keys[0]);
    expect(legacy.executablePath).toBe("Old.exe");
    expect(legacy.archiveSize).toBe(100);
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.legacyHold).toBe(false);
    const response = await h.app.request("http://localhost/resolve", {}, h.env);
    expect((await response.json() as any).archiveKey).toBe(keys[0]);
  });

  it("a new game chooses only one baseline and never overwrites a package snapshot", async () => {
    const h = harness();
    h.db.prepare("DELETE FROM custom_game_versions").run();
    const first = await ensureGameVersion(h.env, h.game);
    expect(first.legacyHold).toBe(true);
    await ensureGameVersion(h.env, { ...h.game, executable_path: "Changed.exe" });
    expect((await findGameVersion(h.env, gameId, keys[0]!))?.executablePath).toBe("Old.exe");
    await ensureGameVersion(h.env, { ...h.game, archive_key: keys[1]! });
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM custom_game_versions WHERE legacy_hold=1").get()?.count).toBe(1);
    expect(() => gameVersionInsertStatement(h.env, { id: gameId, archiveKey: `draft/${gameId}` })).toThrow();
  });

  it("protocol 2 requires a version pin and session for every binary request", async () => {
    const h = harness();
    const response = await h.app.request(`http://localhost/resolve?archiveKey=${encodeURIComponent(keys[0]!)}`, { headers: protocol }, h.env);
    expect(response.status).toBe(409);
    expect((await response.json() as any).code).toBe("game_download_session_required");
    const unsupported = await h.app.request(`http://localhost/resolve?archiveKey=${encodeURIComponent(keys[0]!)}`, {}, h.env);
    expect(unsupported.status).toBe(426);
  });

  it("an unknown old pin never falls forward to the latest package", async () => {
    const h = harness();
    await h.publish(1);
    const response = await h.app.request("http://localhost/inspect?archiveKey=missing-version", { headers: protocol }, h.env);
    expect(response.status).toBe(404);
    expect((await response.json() as any).code).toBe("game_version_not_found");
  });
});

describe("download sessions", () => {
  it("resumes a retired version with its executable, origin, protection and package size", async () => {
    const h = harness();
    await h.publish(1, { origin: "port", protected_paths_json: '["user"]' });
    await h.publish(2);
    const result = await h.request("", { archiveKey: keys[1] });
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ archiveKey: keys[1], archiveSize: 200, executablePath: "Version2.exe", origin: "port", protectedPaths: ["game", "user"], heartbeatSeconds: 60, installName: "Test game" });
    const url = `http://localhost/resolve?archiveKey=${encodeURIComponent(keys[1]!)}&downloadSessionId=${result.body.leaseId}`;
    const response = await h.app.request(url, { headers: protocol }, h.env);
    expect(response.status).toBe(200);
    expect((await response.json() as any).archive_key).toBe(keys[1]);
    const row = h.db.prepare("SELECT * FROM custom_game_download_sessions WHERE id=?").get(result.body.leaseId);
    expect(Date.parse(String(row?.expires_at))).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("does not renew or complete a lease belonging to another license", async () => {
    const h = harness();
    const result = await h.request("", { archiveKey: keys[0] });
    vi.mocked(requireGoldLauncherLicense).mockResolvedValue({ id: 999 } as Awaited<ReturnType<typeof requireGoldLauncherLicense>>);
    expect((await h.request(`/${result.body.leaseId}/heartbeat`)).response.status).toBe(404);
    expect((await h.request(`/${result.body.leaseId}/complete`)).response.status).toBe(404);
    expect(h.db.prepare("SELECT completed_at FROM custom_game_download_sessions WHERE id=?").get(result.body.leaseId)?.completed_at).toBeNull();
  });

  it("refuses mismatched version/session pairs", async () => {
    const h = harness();
    const result = await h.request("", { archiveKey: keys[0] });
    await h.publish(1);
    const response = await h.app.request(`http://localhost/resolve?archiveKey=${encodeURIComponent(keys[1]!)}&downloadSessionId=${result.body.leaseId}`, { headers: protocol }, h.env);
    expect(response.status).toBe(409);
  });

  it("an expired lease can be replaced while the exact version is still retained", async () => {
    const h = harness();
    const result = await h.request("", { archiveKey: keys[0] });
    h.db.prepare("UPDATE custom_game_download_sessions SET expires_at=? WHERE id=?").run(oldTime, result.body.leaseId);
    expect((await h.request(`/${result.body.leaseId}/heartbeat`)).response.status).toBe(409);
    const replacement = await h.request("", { archiveKey: keys[0] });
    expect(replacement.response.status).toBe(200);
    expect(replacement.body.leaseId).not.toBe(result.body.leaseId);
    expect(replacement.body.archiveKey).toBe(keys[0]);
  });

  it("complete and cancel are idempotent and stop renewing the lease", async () => {
    const h = harness();
    const result = await h.request("", { archiveKey: keys[0] });
    expect((await h.request(`/${result.body.leaseId}/complete`)).response.status).toBe(200);
    expect((await h.request(`/${result.body.leaseId}/complete`)).response.status).toBe(200);
    expect((await h.request(`/${result.body.leaseId}/cancel`)).response.status).toBe(200);
    expect((await h.request(`/${result.body.leaseId}/heartbeat`)).response.status).toBe(409);
  });

  it("a removed game renews existing sessions while refusing new ones", async () => {
    const h = harness();
    const session = await h.request("", { archiveKey: keys[0] });
    h.game.published = 0;
    h.db.prepare("UPDATE custom_games SET published=0,deleted_at=? WHERE id=?").run(new Date().toISOString(), gameId);
    expect((await h.request(`/${session.body.leaseId}/heartbeat`)).response.status).toBe(200);
    expect((await h.request("", { archiveKey: keys[0] })).response.status).toBe(404);
  });

  it("a cleanup claim winning the race prevents a new session insert", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    h.hooks.beforeRun = sql => {
      if (sql.startsWith("INSERT INTO custom_game_download_sessions")) {
        h.db.prepare("UPDATE custom_game_versions SET status='deleting' WHERE game_id=? AND archive_key=?").run(gameId, keys[1]!);
      }
    };
    expect((await h.request("", { archiveKey: keys[1] })).response.status).toBe(409);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM custom_game_download_sessions").get()?.count).toBe(0);
  });
});

describe("retired package cleanup", () => {
  it("retains baseline, grace-period packages, and all packages without an integrity readiness check", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove)).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    h.db.prepare("UPDATE custom_game_versions SET delete_after=? WHERE archive_key=?").run(new Date(Date.now() + 60_000).toISOString(), keys[1]!);
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a version with an active download, then deletes it after completion", async () => {
    const h = harness();
    await h.publish(1);
    const session = await h.request("", { archiveKey: keys[1] });
    await h.publish(2);
    const remove = vi.fn(async () => {});
    const options = { canDelete: async () => true };
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).deleted).toBe(0);
    await h.request(`/${session.body.leaseId}/complete`);
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).deleted).toBe(1);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ archiveKey: keys[1] }));
    expect((await findGameVersion(h.env, gameId, keys[0]!))?.status).toBe("retired");
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("deleted");
    expect((await h.request("", { archiveKey: keys[1] })).response.status).toBe(409);
  });

  it("a session insert winning the race blocks the atomic cleanup claim", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    h.hooks.beforeRun = sql => {
      if (sql.startsWith("UPDATE custom_game_versions SET status='deleting'")) {
        h.db.prepare(`INSERT INTO custom_game_download_sessions (id,game_id,archive_key,license_id,expires_at,created_at)
          VALUES ('racing-session',?,?,132,?,?)`).run(gameId, keys[1]!, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
      }
    };
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("retired");
  });

  it("a tombstone does not retain its former current package after leases end", async () => {
    const h = harness();
    await h.publish(1);
    h.db.prepare("UPDATE custom_games SET published=0,deleted_at=? WHERE id=?").run(new Date().toISOString(), gameId);
    await retireGameVersionStatement(h.env, gameId, keys[1]!, { now: oldTime }).run();
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(1);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ archiveKey: keys[1] }));
    expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(0);
  });

  it("invalidates storage preflights before deleting bytes and blocks publication during and after cleanup", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    const staleRevision = h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision;
    const futureKey = "archives/44444444-4444-4444-8444-444444444444.zip";
    const remove = vi.fn(async () => {
      expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("deleting");
      expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(1);
      expect(() => h.db.prepare("UPDATE custom_games SET archive_key=?,storage_revision=? WHERE id=?")
        .run(futureKey, 1, gameId)).toThrow(/custom_game_storage_changed/);
    });
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(() => h.db.prepare("UPDATE custom_games SET archive_key=?,storage_revision=? WHERE id=?")
      .run(futureKey, staleRevision as number, gameId)).toThrow(/custom_game_storage_changed/);
    expect(() => h.db.prepare("UPDATE custom_games SET archive_key=?,storage_revision=? WHERE id=?")
      .run(futureKey, 1, gameId)).not.toThrow();
  });

  it("never deletes R2 data when invalidating the storage preflight fails", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    h.hooks.beforeRun = sql => { if (sql.startsWith("UPDATE custom_games SET storage_revision=")) throw Error("D1 temporary failure"); };
    const remove = vi.fn(async () => {});
    const options = { canDelete: async () => true };
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).failed).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("deleting");
    h.hooks.beforeRun = undefined;
    h.db.prepare("UPDATE custom_game_versions SET delete_after=? WHERE archive_key=?").run(oldTime, keys[1]!);
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).deleted).toBe(1);
    expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(1);
  });

  it("does not delete a global legacy archive still current in another game", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    h.db.prepare(`INSERT INTO custom_games (id,name,install_name,image_key,archive_key,archive_size,published)
      VALUES ('other-game','Other game','Other game','image',?,200,1)`).run(keys[1]!);
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("retired");
  });

  it("does not delete a shared global archive leased by a different game's download", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    await ensureGameVersion(h.env, { ...h.game, id: "other-game", archive_key: keys[1]! }, { legacyHold: false });
    h.db.prepare(`INSERT INTO custom_game_download_sessions (id,game_id,archive_key,license_id,expires_at,created_at)
      VALUES ('other-game-session','other-game',?,132,?,?)`).run(keys[1]!, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not delete a shared global archive held as another game's legacy baseline", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    await ensureGameVersion(h.env, { ...h.game, id: "other-game", archive_key: keys[1]! });
    const remove = vi.fn(async () => {});
    expect((await cleanupRetiredGameVersions(h.env, remove, { canDelete: async () => true })).deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it("retries a partial deletion after a cleanup lease, without allowing new downloads", async () => {
    const h = harness();
    await h.publish(1);
    await h.publish(2);
    const remove = vi.fn().mockRejectedValueOnce(new Error("R2 temporarily unavailable")).mockResolvedValue(undefined);
    const options = { canDelete: async () => true };
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).failed).toBe(1);
    expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(1);
    expect((await findGameVersion(h.env, gameId, keys[1]!))?.status).toBe("deleting");
    expect((await h.request("", { archiveKey: keys[1] })).response.status).toBe(409);
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).deleted).toBe(0);
    expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(1);
    h.db.prepare("UPDATE custom_game_versions SET delete_after=? WHERE archive_key=?").run(oldTime, keys[1]!);
    expect((await cleanupRetiredGameVersions(h.env, remove, options)).deleted).toBe(1);
    expect(h.db.prepare("SELECT storage_revision FROM custom_games WHERE id=?").get(gameId)?.storage_revision).toBe(2);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
