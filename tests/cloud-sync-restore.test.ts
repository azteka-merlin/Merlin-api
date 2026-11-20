import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/types";

vi.mock("../src/lib/launcher-auth", () => ({ requireLauncherLicense: async () => ({ id: 1 }) }));

import { getCloudGame, getCloudExport, getCloudExportFile, listCloudGames, restoreCloudGame } from "../src/lib/cloud-sync";
import { captureCurrentExportSnapshot, captureVisibleSnapshot, protectBlob, pruneHistory } from "../src/lib/cloud-save-history-v2";

const prefix = "cloud-sync/stage/steam/123456/730/";
const recoveryPrefix = "cloud-sync/stage/recovery/steam/123456/730/";
const oldSaveSha = "a".repeat(40);
const oldIndexSha = "d".repeat(40);
const newSaveSha = "b".repeat(40);
const newIndexSha = "e".repeat(40);
const unchangedSha = "c".repeat(40);
const capturedAt = new Date("2026-10-09T08:59:37Z");

function fixture({ active = false, missingCurrentBlob = false, pageSize = 1000, omitListMetadata = false,
  catalogRows = {} as Record<string, { name: string; cover_url: string | null }> } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; uploaded: Date }>();
  const calls = { lists: [] as { prefix: string; delimiter?: string; include?: string[] }[],
    gets: [] as string[], heads: 0, catalog: [] as string[][] };
  const put = (key: string, value: string, metadata: Record<string, string> = {}, uploaded = new Date()) => {
    objects.set(key, { bytes: new TextEncoder().encode(value), metadata, uploaded });
  };
  const current = { v: 2, cn: 6, files: {
    "save.dat": { sha: newSaveSha, size: 8, ts: 2 },
    "index.dat": { sha: newIndexSha, size: 9, ts: 2 },
    "settings.dat": { sha: unchangedSha, size: 4, ts: 1 },
  }, ...(active ? { session: { client_id: "123", op: "active" } } : {}) };
  put(`${prefix}state.cloudredirect`, JSON.stringify(current));
  put(`${prefix}cn.cloudredirect`, "6");
  if (!missingCurrentBlob) put(`${prefix}blobs/save.dat/${newSaveSha}`, "new-save");
  put(`${prefix}blobs/index.dat/${newIndexSha}`, "new-index");
  put(`${prefix}blobs/settings.dat/${unchangedSha}`, "settings");
  put(`${recoveryPrefix}old-save`, "old-save", {
    originalKey: `steam/123456/730/blobs/save.dat/${oldSaveSha}`, snapshotId: "5",
  }, capturedAt);
  put(`${recoveryPrefix}old-index`, "old-index", {
    originalKey: `steam/123456/730/blobs/index.dat/${oldIndexSha}`, snapshotId: "5",
  }, new Date(capturedAt.getTime() + 2000));
  // Metadata copies must not turn into save files or inflate the backup size.
  put(`${recoveryPrefix}state`, JSON.stringify(current), {
    originalKey: "steam/123456/730/state.cloudredirect", snapshotId: "5",
  }, new Date(capturedAt.getTime() + 20 * 60_000));
  const minute = Math.floor(capturedAt.getTime() / 60_000);
  const recoveryId = createHash("sha256").update(`123456/730/5:${minute}`).digest("hex");
  const bucket = {
    async get(key: string) {
      calls.gets.push(key);
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.bytes]).stream(), size: object.bytes.length,
        etag: createHash("md5").update(object.bytes).digest("hex"),
        uploaded: object.uploaded, customMetadata: object.metadata,
        text: async () => new TextDecoder().decode(object.bytes),
      };
    },
    async head(key: string) {
      calls.heads += 1;
      const object = objects.get(key);
      return object ? { size: object.bytes.length, customMetadata: object.metadata } : null;
    },
    async put(key: string, body: string | Uint8Array | ReadableStream,
      options?: { customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const previous = objects.get(key);
      if (options?.onlyIf?.etagMatches && (!previous || createHash("md5").update(previous.bytes).digest("hex") !== options.onlyIf.etagMatches)) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
      const bytes = typeof body === "string" ? new TextEncoder().encode(body)
        : body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, metadata: options?.customMetadata || {}, uploaded: new Date() });
      return { etag: createHash("md5").update(bytes).digest("hex") };
    },
    async delete(key: string) { objects.delete(key); },
    async list({ prefix: listPrefix, delimiter, include, cursor, limit = 1000 }:
      { prefix: string; delimiter?: string; include?: string[]; cursor?: string; limit?: number }) {
      calls.lists.push({ prefix: listPrefix, delimiter, include });
      const keys = [...objects.keys()].filter((key) => key.startsWith(listPrefix)).sort();
      const entries = [...new Set(keys.map((key) => {
        const tail = key.slice(listPrefix.length);
        const boundary = delimiter ? tail.indexOf(delimiter) : -1;
        return boundary < 0 ? key : `${listPrefix}${tail.slice(0, boundary + delimiter!.length)}`;
      }))];
      const start = cursor ? entries.indexOf(cursor) + 1 : 0;
      const count = Math.min(limit, pageSize);
      const page = entries.slice(start, start + count);
      const truncated = start + count < entries.length;
      return { truncated, cursor: truncated ? page.at(-1) : undefined,
        delimitedPrefixes: page.filter((key) => !objects.has(key)),
        objects: page.filter((key) => objects.has(key)).map((key) => {
          const object = objects.get(key)!;
          return { key, size: object.bytes.length, uploaded: object.uploaded,
            ...(include?.includes("customMetadata") && !omitListMetadata ? { customMetadata: object.metadata } : {}) };
        }) };
    },
  };
  const context = {
    env: { ENVIRONMENT: "staging", MERLIN_FILES: bucket,
      merlin_db: { prepare: (sql: string) => ({ bind: (...ids: string[]) => ({
        first: async () => null,
        all: async () => { calls.catalog.push(ids); return { results: ids.filter((id) => catalogRows[id])
          .map((app_id) => ({ app_id, ...catalogRows[app_id] })) }; },
      }) }) } },
    req: {
      json: async () => ({ accountId: "123456", appId: "730", recoveryId }),
      query: () => "123456",
      param: () => "730",
    },
    json: (value: unknown, status: number) => Response.json(value, { status }),
  } as unknown as AppContext;
  return { context, objects, current, put, recoveryId, calls };
}

describe("cloud save restoration", () => {
  it("labels a full backup by the saved files and preserves its export identity", async () => {
    const { context, put, calls, objects } = fixture();
    const savedAt = "2026-11-17T18:58:06.000Z";
    const capturedAt = "2026-11-18T03:36:38.385Z";
    const key = "cloud-sync/stage/history-v2/steam/123456/730/visible/previous.json";
    const id = createHash("sha256").update(key).digest("hex");
    const snapshot = JSON.stringify({ format: 2, createdAt: capturedAt, state: { cn: 5, files: {
      "save.dat": { sha: oldSaveSha, size: 8, ts: Date.parse(savedAt) / 1000 },
      "settings.dat": { sha: unchangedSha, size: 8, ts: Date.parse("2099-01-01") / 1000 },
    } } });
    put(key, snapshot, new Date(capturedAt));
    put(key.replace("previous.json", "earlier.json"), snapshot, new Date(capturedAt));
    const liveBlob = prefix + "blobs/save.dat/" + oldSaveSha;
    put(liveBlob, "old-save");

    const details = await (await getCloudGame(context)).json();
    expect(details.game.backups[0]).toMatchObject({ id, version: 2, createdAt: savedAt, savedAt, capturedAt });
    const exportContext = {
      ...context,
      req: { ...context.req, param: (name: string) => name === "appId" ? "730" : id,
        query: (name: string) => name === "accountId" ? "123456" : "save.dat" },
    } as AppContext;
    const exported = await (await getCloudExport(exportContext)).json();
    expect(exported.createdAt).toBe(savedAt);
    expect(exported.files).toContainEqual({ name: "save.dat", sha: oldSaveSha, size: 8 });
    calls.gets.length = 0;
    expect(await (await getCloudExportFile(exportContext)).text()).toBe("old-save");
    expect(calls.gets).toEqual([key, liveBlob]);
    expect(calls.heads).toBe(0);

    objects.delete(liveBlob);
    const archive = "cloud-sync/stage/history-v2/steam/123456/730/blobs/blobs/save.dat/" + oldSaveSha;
    put(archive, "old-save");
    calls.gets.length = 0;
    expect(await (await getCloudExportFile(exportContext)).text()).toBe("old-save");
    expect(calls.gets).toEqual([key, liveBlob, archive]);
  });

  it("retains the capture date for a complete backup without file timestamps", async () => {
    const { context, put, current } = fixture();
    const historyKey = "cloud-sync/stage/history-v2/steam/123456/730/visible/old-metadata.json";
    const capture = "2026-11-18T03:36:38.385Z";
    put(historyKey, JSON.stringify({ format: 2, createdAt: capture, state: current }), new Date(capture));
    const details = await (await getCloudGame(context)).json();
    expect(details.game.backups[0]).toMatchObject({ version: 2, createdAt: capture, savedAt: null, capturedAt: capture });
  });

  it("exports only explicitly captured complete V2 versions, never legacy recovery groups", async () => {
    const { context, current } = fixture();
    const req = { ...context.req, param: (name: string) => name === "appId" ? "730" : "current",
      query: (name: string) => name === "accountId" ? "123456" : "save.dat" };
    const exportContext = { ...context, req } as AppContext;
    expect((await getCloudExport(exportContext)).status).toBe(404);
    const scope = { accountId: "123456", appId: "730", prefix };
    await captureCurrentExportSnapshot(context, scope, current);
    const manifest = await (await getCloudExport(exportContext)).json() as { files: { name: string }[] };
    expect(manifest.files.map((file) => file.name)).toContain("save.dat");
    const file = await getCloudExportFile(exportContext);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("new-save");
  });

  it("lists only the two overwritten save files, not unrelated state metadata", async () => {
    const { context, recoveryId, calls } = fixture();
    const response = await getCloudGame(context);
    expect(response.status).toBe(200);
    const result = await response.json() as { game: { backups: { id: string; fileCount: number; totalSize: number }[];
      localSaveHints: string[] } };
    expect(result.game.backups).toEqual([{ id: recoveryId, createdAt: expect.any(String), fileCount: 2, totalSize: 17 }]);
    expect(result.game.localSaveHints).toEqual(["save.dat", "index.dat", "settings.dat"]);
    expect(calls.heads).toBe(0);
    expect(calls.lists.some((call) => call.include?.includes("customMetadata"))).toBe(true);
  });

  it("falls back to HEAD for a legacy listing without metadata", async () => {
    const { context, recoveryId, calls } = fixture({ omitListMetadata: true });
    const result = await (await getCloudGame(context)).json() as { game: { backups: { id: string }[] } };
    expect(result.game.backups[0]?.id).toBe(recoveryId);
    expect(calls.heads).toBeGreaterThan(0);
  });

  it("discovers game folders instead of all save blobs and batches catalog names", async () => {
    const { context, put, current, calls } = fixture({ pageSize: 2,
      catalogRows: { "730": { name: "Catalog title", cover_url: "https://example.test/cover.jpg" } } });
    for (let appId = 1000; appId < 1102; appId++) {
      put(`cloud-sync/stage/steam/123456/${appId}/state.cloudredirect`, JSON.stringify(current));
      put(`cloud-sync/stage/steam/123456/${appId}/blobs/save.dat/${newSaveSha}`, "data");
    }
    put(`cloud-sync/stage/steam/123456/1200/blobs/orphan/${newSaveSha}`, "orphan");
    const response = await listCloudGames(context);
    const result = await response.json() as { games: { appId: string; backupCount: number }[] };
    expect(result.games).toHaveLength(103);
    expect(result.games.find((game) => game.appId === "1200")).toBeUndefined();
    expect(result.games.find((game) => game.appId === "730")?.backupCount).toBe(1);
    expect(result.games.find((game) => game.appId === "730")?.name).toBe("Catalog title");
    expect(calls.catalog.map((batch) => batch.length)).toEqual([100, 4]);
    expect(calls.lists.filter((call) => call.prefix === "cloud-sync/stage/steam/123456/")
      .every((call) => call.delimiter === "/")).toBe(true);
    expect(calls.lists.filter((call) => call.prefix === "cloud-sync/stage/steam/123456/").length).toBeGreaterThan(1);
    expect(calls.heads).toBe(0);
  });

  it("keeps production saves separate from stage in the shared bucket", async () => {
    const { context, put, current } = fixture();
    const production = { ...context, env: { ...context.env, ENVIRONMENT: "production" } } as AppContext;
    expect((await getCloudGame(production)).status).toBe(404);
    const emptyList = await (await listCloudGames(production)).json() as { games: unknown[] };
    expect(emptyList.games).toEqual([]);
    const productionPrefix = prefix.replace("cloud-sync/stage/", "cloud-sync/production/");
    put(`${productionPrefix}state.cloudredirect`, JSON.stringify(current));
    const list = await (await listCloudGames(production)).json() as { games: { appId: string }[] };
    expect(list.games.map((game) => game.appId)).toEqual(["730"]);
    const response = await getCloudGame(production);
    expect(response.status).toBe(200);
    const result = await response.json() as { game: { backups: unknown[]; currentVersion: { fileCount: number } } };
    expect(result.game.currentVersion.fileCount).toBe(3);
    expect(result.game.backups).toEqual([]);
  });

  it("keeps the backup ID stable if another copy joins the same save minute", async () => {
    const { context, put, recoveryId } = fixture();
    put(`${recoveryPrefix}extra`, "extra", {
      originalKey: `steam/123456/730/blobs/extra.dat/${"f".repeat(40)}`, snapshotId: "5",
    }, new Date(capturedAt.getTime() + 3000));
    const result = await (await getCloudGame(context)).json() as { game: { backups: { id: string }[] } };
    expect(result.game.backups[0]?.id).toBe(recoveryId);
  });

  it("restores old files while preserving every other current file", async () => {
    const { context, objects, current } = fixture();
    const response = await restoreCloudGame(context);
    expect(response.status).toBe(200);
    const state = JSON.parse(new TextDecoder().decode(objects.get(`${prefix}state.cloudredirect`)!.bytes));
    expect(state.files["save.dat"].sha).toBe(oldSaveSha);
    expect(state.files["index.dat"].sha).toBe(oldIndexSha);
    expect(state.files["settings.dat"]).toEqual(current.files["settings.dat"]);
    expect(Object.keys(state.files)).toHaveLength(3);
    expect(state.cn).toBe(7);
    expect(state.session).toBeUndefined();
    expect(objects.has(`${prefix}blobs/save.dat/${oldSaveSha}`)).toBe(true);
    expect(objects.has(`${prefix}blobs/index.dat/${oldIndexSha}`)).toBe(true);
  });

  it("blocks restoration while the game has an active cloud session", async () => {
    const { context, objects, current } = fixture({ active: true });
    const response = await restoreCloudGame(context);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("game_active");
    expect(JSON.parse(new TextDecoder().decode(objects.get(`${prefix}state.cloudredirect`)!.bytes))).toEqual(current);
  });

  it("leaves the current version untouched when its current blob is missing", async () => {
    const { context, objects, current } = fixture({ missingCurrentBlob: true });
    const response = await restoreCloudGame(context);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("recovery_incomplete");
    expect(JSON.parse(new TextDecoder().decode(objects.get(`${prefix}state.cloudredirect`)!.bytes))).toEqual(current);
  });

  it("restores every file in a complete v2 snapshot and preserves legacy backups", async () => {
    const { context, objects, current, recoveryId } = fixture();
    const scope = { accountId: "123456", appId: "730", prefix };
    await captureVisibleSnapshot(context, scope, current);
    const oldState = structuredClone(current);
    oldState.files["save.dat"] = { sha: oldSaveSha, size: 8, ts: 3 };
    objects.set(`${prefix}blobs/save.dat/${oldSaveSha}`, {
      bytes: new TextEncoder().encode("old-save"), metadata: {}, uploaded: new Date(),
    });
    objects.set(`${prefix}state.cloudredirect`, {
      bytes: new TextEncoder().encode(JSON.stringify(oldState)), metadata: {}, uploaded: new Date(),
    });
    const details = await (await getCloudGame(context)).json() as { game: { backups: { id: string; version?: number }[] } };
    expect(details.game.backups).toHaveLength(2);
    const v2 = details.game.backups.find((item) => item.version === 2)!;
    const response = await restoreCloudGame({ ...context, req: { ...context.req,
      json: async () => ({ accountId: "123456", appId: "730", recoveryId: v2.id }),
    } } as AppContext);
    expect(response.status).toBe(200);
    const restored = JSON.parse(new TextDecoder().decode(objects.get(`${prefix}state.cloudredirect`)!.bytes));
    expect(restored.files).toEqual(current.files);
    const after = await (await getCloudGame(context)).json() as { game: { backups: { id: string }[];
      currentVersion: { version?: number } } };
    expect(after.game.currentVersion.version).toBe(2);
    expect(after.game.backups.some((item) => item.id === recoveryId)).toBe(true);
    expect(objects.has("cloud-sync/stage/history-v2/steam/123456/730/hidden/current.json")).toBe(true);
  });

  it("keeps only ten visible v2 versions while preserving protected blobs", async () => {
    const { context, current, objects } = fixture();
    const scope = { accountId: "123456", appId: "730", prefix };
    for (let index = 0; index < 11; index++) {
      const state = structuredClone(current);
      state.cn = index + 10;
      state.files["save.dat"].size = index + 10;
      await captureVisibleSnapshot(context, scope, state);
    }
    await pruneHistory(context, scope);
    const keys = [...objects.keys()].filter((key) => key.includes("/history-v2/steam/123456/730/visible/"));
    expect(keys).toHaveLength(10);
  });

  it("archives a referenced blob before deletion and restores it from the archive", async () => {
    const { context, current, objects } = fixture();
    const scope = { accountId: "123456", appId: "730", prefix };
    await captureVisibleSnapshot(context, scope, current);
    const key = `${prefix}blobs/save.dat/${newSaveSha}`;
    await protectBlob(context, scope, key);
    objects.delete(key);
    expect(objects.has("cloud-sync/stage/history-v2/steam/123456/730/blobs/blobs/save.dat/" + newSaveSha)).toBe(true);
    const other = structuredClone(current);
    other.files["save.dat"] = { sha: oldSaveSha, size: 8, ts: 3 };
    objects.set(`${prefix}blobs/save.dat/${oldSaveSha}`, {
      bytes: new TextEncoder().encode("old-save"), metadata: {}, uploaded: new Date(),
    });
    objects.set(`${prefix}state.cloudredirect`, {
      bytes: new TextEncoder().encode(JSON.stringify(other)), metadata: {}, uploaded: new Date(),
    });
    const details = await (await getCloudGame(context)).json() as { game: { backups: { id: string; version?: number }[] } };
    const id = details.game.backups.find((item) => item.version === 2)!.id;
    const response = await restoreCloudGame({ ...context, req: { ...context.req,
      json: async () => ({ accountId: "123456", appId: "730", recoveryId: id }),
    } } as AppContext);
    expect(response.status).toBe(200);
    expect(objects.has(key)).toBe(true);
  });

  it("keeps legacy recovery objects when restoring in v2 staging", async () => {
    const { context, objects } = fixture();
    const before = [...objects.keys()].filter((key) => key.startsWith(recoveryPrefix)).sort();
    const response = await restoreCloudGame(context);
    expect(response.status).toBe(200);
    const after = [...objects.keys()].filter((key) => key.startsWith(recoveryPrefix)).sort();
    expect(after).toEqual(before);
    expect(objects.has("cloud-sync/stage/history-v2/steam/123456/730/hidden/current.json")).toBe(true);
  });
});
