import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppBindings } from "../types";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn().mockResolvedValue({}) }));
vi.mock("./launcher-auth", () => ({
  requireLauncherLicense: vi.fn().mockResolvedValue({}),
  requireGoldLauncherLicense: vi.fn().mockResolvedValue({ planTier: "ouro" }),
}));

import { registerCustomGamesRoutes } from "./custom-games";
import { requireAdminSession } from "./admin-security";

const key = "00000000-0000-4000-8000-000000000000/files/00000000-0000-4000-8000-000000000001";

describe("large ZIP multipart uploads", () => {
  it("accepts 100 GiB archives and allows the corresponding 1,600th part", async () => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const uploadPart = vi.fn(async (partNumber: number) => ({ partNumber, etag: "etag" }));
    const createMultipartUpload = vi.fn(async () => ({ uploadId: "upload-1" }));
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: {
      createMultipartUpload,
      resumeMultipartUpload: vi.fn(() => ({ uploadPart })),
    } } as unknown as AppBindings;

    const init = await app.request("http://localhost/panel-api/custom-games/upload/initiate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, filename: "game.zip", packageType: "zip", sizeBytes: 100 * 1024 ** 3 }),
    }, env);
    expect(init.status).toBe(200);
    const upload = await init.json() as { key: string; partSize: number };
    expect(upload.key).toMatch(new RegExp(`^${gameId}/archives/[0-9a-f-]{36}\\.zip$`));
    expect(upload.partSize).toBe(64 * 1024 * 1024);
    expect(createMultipartUpload).toHaveBeenCalledWith(upload.key, expect.any(Object));
    const part = await app.request(`http://localhost/panel-api/custom-games/upload/part?key=${upload.key}&uploadId=upload-1&partNumber=1600`, {
      method: "POST", headers: { "content-length": "3" }, body: "abc",
    }, env);
    expect(part.status).toBe(200);
    expect(await part.json()).toMatchObject({ partNumber: 1600 });
    expect(uploadPart).toHaveBeenCalledWith(1600, expect.anything());

    const tooManyParts = await app.request(`http://localhost/panel-api/custom-games/upload/part?key=${upload.key}&uploadId=upload-1&partNumber=1601`, {
      method: "POST", headers: { "content-length": "3" }, body: "abc",
    }, env);
    expect(tooManyParts.status).toBe(400);
    expect(uploadPart).toHaveBeenCalledTimes(1);
  });

  it("rejects archives larger than 100 GiB", async () => {
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const createMultipartUpload = vi.fn();
    const env = { CUSTOM_GAMES: { createMultipartUpload } } as unknown as AppBindings;
    const response = await app.request("http://localhost/panel-api/custom-games/upload/initiate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "00000000-0000-4000-8000-000000000000", filename: "game.zip",
        packageType: "zip", sizeBytes: 100 * 1024 ** 3 + 1 }),
    }, env);
    expect(response.status).toBe(400);
    expect(createMultipartUpload).not.toHaveBeenCalled();
  });
});

describe("direct custom-game file upload", () => {
  it("uses one conditional R2 PUT normally and HEAD only when retrying", async () => {
    const objects = new Map<string, { size: number; etag: string }>();
    const head = vi.fn(async (objectKey: string) => objects.get(objectKey) || null);
    const put = vi.fn(async (objectKey: string, _body: unknown, options: { onlyIf: Headers }) => {
      expect(options.onlyIf.get("If-None-Match")).toBe("*");
      if (objects.has(objectKey)) return null;
      const object = { size: 4, etag: "etag-1" };
      objects.set(objectKey, object);
      return object;
    });
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: { head, put } } as unknown as AppBindings;
    const upload = (retry = false) => app.request(`http://localhost/panel-api/custom-games/upload/file?key=${key}`, {
      method: "POST",
      headers: { "content-length": "4", ...(retry ? { "x-upload-retry": "1" } : {}) },
      body: "test",
    }, env);

    expect((await upload()).status).toBe(200);
    expect(head).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect((await upload(true)).status).toBe(200);
    expect(head).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await upload()).status).toBe(409);
    expect(put).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requireAdminSession)).toHaveBeenCalledWith(expect.anything(), { mutate: true, touch: false });
  });
});

describe("hybrid folder manifest", () => {
  it("checks only the stored objects and records bundled members for the Launcher", async () => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const bundleKey = `${gameId}/files/00000000-0000-4000-8000-000000000002`;
    const head = vi.fn(async (objectKey: string) => ({ size: objectKey === key ? 5 : 128, etag: "etag" }));
    const put = vi.fn(async (_objectKey: string, _body: string) => ({ etag: "manifest" }));
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: { head, put } } as unknown as AppBindings;
    const body = { gameId, manifestId: "00000000-0000-4000-8000-000000000003",
      files: [{ path: "Game/large.dat", key, sizeBytes: 5, sha256: "a".repeat(64) }],
      bundles: [{ key: bundleKey, sizeBytes: 128, sha256: "b".repeat(64),
        files: [{ path: "Game/small.dat", sizeBytes: 4, sha256: "c".repeat(64) }] }] };
    const response = await app.request("http://localhost/panel-api/custom-games/upload/folder/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, env);
    expect(response.status).toBe(201);
    expect(head).toHaveBeenCalledTimes(2);
    const manifest = JSON.parse(put.mock.calls[0]![1] as string);
    expect(manifest.version).toBe(3);
    expect(manifest.totalSizeBytes).toBe(9);
    expect(manifest.bundles[0].files[0].path).toBe("Game/small.dat");
  });

  it("accepts more than 100 packages with members larger than 1 MiB", async () => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const memberSize = 2 * 1024 * 1024;
    const bundles = Array.from({ length: 101 }, (_, index) => ({
      key: `${gameId}/files/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sizeBytes: memberSize + 1024,
      sha256: "b".repeat(64),
      files: [{ path: `Game/file-${index}.dat`, sizeBytes: memberSize, sha256: "c".repeat(64) }],
    }));
    const put = vi.fn(async (_objectKey: string, _body: string) => ({ etag: "manifest" }));
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: {
      head: vi.fn(async () => ({ size: memberSize + 1024, etag: "etag" })), put,
    } } as unknown as AppBindings;
    const response = await app.request("http://localhost/panel-api/custom-games/upload/folder/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        gameId, manifestId: "00000000-0000-4000-8000-000000000003", files: [], bundles,
      }),
    }, env);
    expect(response.status).toBe(201);
    expect(JSON.parse(put.mock.calls[0]![1] as string).bundles).toHaveLength(101);
  });

  it("validates thousands of legacy objects with paginated R2 listings", async () => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const files = Array.from({ length: 2501 }, (_, index) => ({
      path: `Game/file-${index}.dat`,
      key: `${gameId}/files/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sizeBytes: 1, sha256: "a".repeat(64),
    }));
    const list = vi.fn(async (options: { prefix: string; limit: number; cursor?: string }) => {
      expect(options.prefix).toBe(`${gameId}/files/`);
      expect(options.limit).toBe(1000);
      const start = Number(options.cursor || 0);
      const end = Math.min(start + 1000, files.length);
      return { objects: files.slice(start, end).map(file => ({ key: file.key, size: 1, etag: "etag" })),
        truncated: end < files.length, cursor: end < files.length ? String(end) : undefined };
    });
    const head = vi.fn();
    const put = vi.fn(async (_objectKey: string, _body: string) => ({ etag: "manifest" }));
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: { list, head, put } } as unknown as AppBindings;
    const response = await app.request("http://localhost/panel-api/custom-games/upload/folder/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        gameId, manifestId: "00000000-0000-4000-8000-000000000003", files,
      }),
    }, env);
    expect(response.status).toBe(201);
    expect(list).toHaveBeenCalledTimes(3);
    expect(head).not.toHaveBeenCalled();
    expect(JSON.parse(put.mock.calls[0]![1] as string).files).toHaveLength(2501);
  });

  it.each(["missing", "wrong size"])("does not publish a manifest with a %s object", async problem => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const files = Array.from({ length: 129 }, (_, index) => ({
      path: `Game/file-${index}.dat`,
      key: `${gameId}/files/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sizeBytes: 1, sha256: "a".repeat(64),
    }));
    const listed = files.slice(problem === "missing" ? 1 : 0).map((file, index) => ({
      key: file.key, size: problem === "wrong size" && index === 0 ? 2 : 1, etag: "etag",
    }));
    const put = vi.fn();
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: { list: vi.fn(async () => ({ objects: listed, truncated: false })), put } } as unknown as AppBindings;
    const response = await app.request("http://localhost/panel-api/custom-games/upload/folder/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        gameId, manifestId: "00000000-0000-4000-8000-000000000003", files,
      }),
    }, env);
    expect(response.status).toBe(409);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("discarding unused folder uploads", () => {
  it("deletes thousands of R2 objects in batches of at most 1,000", async () => {
    const gameId = "00000000-0000-4000-8000-000000000000";
    const manifestKey = `${gameId}/manifests/00000000-0000-4000-8000-000000000003.json`;
    const files = Array.from({ length: 2001 }, (_, index) => ({
      key: `${gameId}/files/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const deleted: Array<string | string[]> = [];
    const app = new Hono<{ Bindings: AppBindings }>();
    registerCustomGamesRoutes(app);
    const env = { CUSTOM_GAMES: {
      get: vi.fn(async () => ({ json: async () => ({ files, bundles: [] }) })),
      delete: vi.fn(async (keys: string | string[]) => { deleted.push(keys); }),
    }, merlin_db: { prepare: vi.fn(() => ({ bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }) })) } } as unknown as AppBindings;
    const response = await app.request("http://localhost/panel-api/custom-games/upload/discard", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: manifestKey }),
    }, env);
    expect(response.status).toBe(200);
    expect(deleted.filter(Array.isArray).map(keys => keys.length)).toEqual([1000, 1000, 1]);
    expect(deleted.at(-1)).toBe(manifestKey);
  });
});
