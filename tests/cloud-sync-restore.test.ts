import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/types";

vi.mock("../src/lib/launcher-auth", () => ({ requireLauncherLicense: async () => ({ id: 1 }) }));

import { getCloudGame, listCloudGames, restoreCloudGame } from "../src/lib/cloud-sync";

const prefix = "cloud-sync/stage/steam/123456/730/";
const recoveryPrefix = "cloud-sync/stage/recovery/steam/123456/730/";
const oldSaveSha = "a".repeat(40);
const oldIndexSha = "d".repeat(40);
const newSaveSha = "b".repeat(40);
const newIndexSha = "e".repeat(40);
const unchangedSha = "c".repeat(40);
const capturedAt = new Date("2026-10-09T08:59:37Z");

function fixture({ active = false, missingCurrentBlob = false } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; uploaded: Date }>();
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
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.bytes]).stream(), size: object.bytes.length,
        uploaded: object.uploaded, customMetadata: object.metadata,
        text: async () => new TextDecoder().decode(object.bytes),
      };
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.length, customMetadata: object.metadata } : null;
    },
    async put(key: string, body: string | Uint8Array | ReadableStream, options?: { customMetadata?: Record<string, string> }) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body)
        : body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, metadata: options?.customMetadata || {}, uploaded: new Date() });
    },
    async delete(key: string) { objects.delete(key); },
    async list({ prefix: listPrefix }: { prefix: string }) {
      return { truncated: false, objects: [...objects.entries()].filter(([key]) => key.startsWith(listPrefix))
        .map(([key, object]) => ({ key, size: object.bytes.length, uploaded: object.uploaded })) };
    },
  };
  const context = {
    env: { ENVIRONMENT: "staging", MERLIN_FILES: bucket,
      merlin_db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } },
    req: {
      json: async () => ({ accountId: "123456", appId: "730", recoveryId }),
      query: () => "123456",
      param: () => "730",
    },
    json: (value: unknown, status: number) => Response.json(value, { status }),
  } as unknown as AppContext;
  return { context, objects, current, put, recoveryId };
}

describe("cloud save restoration", () => {
  it("lists only the two overwritten save files, not unrelated state metadata", async () => {
    const { context, recoveryId } = fixture();
    const response = await getCloudGame(context);
    expect(response.status).toBe(200);
    const result = await response.json() as { game: { backups: { id: string; fileCount: number; totalSize: number }[] } };
    expect(result.game.backups).toEqual([{ id: recoveryId, createdAt: expect.any(String), fileCount: 2, totalSize: 17 }]);
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
});
