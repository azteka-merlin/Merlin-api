import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppBindings } from "../types";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn().mockResolvedValue({}) }));
vi.mock("./launcher-auth", () => ({ requireLauncherLicense: vi.fn().mockResolvedValue({}) }));

import { registerCustomGamesRoutes } from "./custom-games";
import { requireAdminSession } from "./admin-security";

const key = "00000000-0000-4000-8000-000000000000/files/00000000-0000-4000-8000-000000000001";

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
});
