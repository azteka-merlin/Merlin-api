import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppBindings } from "../types";

vi.mock("./admin-security", () => ({ requireAdminSession: vi.fn() }));
import { requireAdminSession } from "./admin-security";
import { cleanupExpiredGameUploads, registerGameUploadSessionRoutes } from "./custom-game-upload-sessions";
import { registerCustomGamesRoutes } from "./custom-games";

const gameId = "11111111-1111-4111-8111-111111111111";
const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function harness(direct = false) {
  let counter = 0;
  const objects = new Map<string, { bytes: Uint8Array; etag: string; size: number }>();
  const multiparts = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const bucket = {
    put: vi.fn(async (key: string, value: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      const prior = objects.get(key);
      if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && prior) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const result = { bytes, etag: `etag-${++counter}`, size: bytes.byteLength };
      objects.set(key, result); return result;
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value ? { ...value, json: async () => JSON.parse(new TextDecoder().decode(value.bytes)) } : null;
    }),
    head: vi.fn(async (key: string) => objects.get(key) || null),
    delete: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }),
    list: vi.fn(async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = Number(cursor || 0); const page = keys.slice(offset, offset + 1000);
      return { objects: page.map(key => ({ key, ...objects.get(key)! })), truncated: offset + 1000 < keys.length,
        cursor: offset + 1000 < keys.length ? String(offset + 1000) : undefined };
    }),
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `upload-${++counter}`; multiparts.set(uploadId, { key, parts: new Map() }); return { uploadId };
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) => ({
      uploadPart: async (partNumber: number, stream: ReadableStream) => {
        const upload = multiparts.get(uploadId); if (!upload || upload.key !== key) throw Error("missing upload");
        upload.parts.set(partNumber, new Uint8Array(await new Response(stream).arrayBuffer()));
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async () => {
        const upload = multiparts.get(uploadId); if (!upload || upload.key !== key) throw Error("missing upload");
        const bytes = new Uint8Array([...upload.parts.values()].flatMap(part => [...part]));
        objects.set(key, { bytes, etag: `complete-${++counter}`, size: bytes.length }); multiparts.delete(uploadId);
      },
      abort: async () => { multiparts.delete(uploadId); },
    })),
  };
  const app = new Hono<{ Bindings: AppBindings }>();
  registerCustomGamesRoutes(app);
  const env = { CUSTOM_GAMES: bucket, ...(direct ? { CUSTOM_GAMES_R2_ACCOUNT_ID: "a".repeat(32),
    CUSTOM_GAMES_R2_ACCESS_KEY_ID: "ACCESS-EXAMPLE", CUSTOM_GAMES_R2_SECRET_ACCESS_KEY: "secret-example" } : {}) } as unknown as AppBindings;
  async function request(path: string, body?: unknown, method = "POST") {
    const response = await app.request(`http://localhost/panel-api/custom-games/upload/${path}`, {
      method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }, env);
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() as any : await response.text() };
  }
  async function session() {
    return (await request("sessions", { gameId, fingerprint: "a".repeat(64), planVersion: 2 })).body;
  }
  return { app, env, request, session, bucket, multiparts, objects };
}

beforeEach(() => {
  vi.mocked(requireAdminSession).mockResolvedValue({ session: { admin_user_id: 1 } } as Awaited<ReturnType<typeof requireAdminSession>>);
});

describe("persistent custom-game upload sessions", () => {
  it("persists reservations and completed checkpoints; completion replay never creates or finishes another upload", async () => {
    const h = harness(); const session = await h.session();
    expect(session.transport).toBe("proxy");
    const path = `sessions/${session.sessionId}/objects`;
    const initBody = { clientId: "file-0", filename: "Game/data.bin", sizeBytes: 4 };
    const first = await h.request(`${path}/initiate`, initBody);
    const again = await h.request(`${path}/initiate`, initBody);
    expect(again.body.key).toBe(first.body.key);
    expect(h.bucket.createMultipartUpload).toHaveBeenCalledTimes(1);
    h.multiparts.get(first.body.uploadId)!.parts.set(1, new TextEncoder().encode("test"));
    const complete = { clientId: "file-0", sizeBytes: 4, sha256: "b".repeat(64), parts: [{ partNumber: 1, etag: "part-1" }] };
    const completed = await h.request(`${path}/complete`, complete);
    expect(completed.status).toBe(200);
    expect((await h.request(`${path}/complete`, complete)).body.etag).toBe(completed.body.etag);
    expect(h.bucket.resumeMultipartUpload).toHaveBeenCalledTimes(1);
    expect((await h.request(`${path}/complete`, { ...complete, sha256: "c".repeat(64) })).status).toBe(409);
    const restored = await h.request(`sessions/${session.sessionId}`, undefined, "GET");
    expect(restored.body.objects).toEqual([expect.objectContaining({ clientId: "file-0", completed: true, sha256: complete.sha256, sizeBytes: 4 })]);
  });

  it("recovers when multipart completion succeeded but its response was lost", async () => {
    const h = harness(); const session = await h.session(); const path = `sessions/${session.sessionId}/objects`;
    const init = (await h.request(`${path}/initiate`, { clientId: "one", filename: "a.bin", sizeBytes: 4 })).body;
    h.objects.set(init.key, { bytes: new TextEncoder().encode("test"), etag: "already-complete", size: 4 });
    h.multiparts.delete(init.uploadId);
    const result = await h.request(`${path}/complete`, { clientId: "one", sizeBytes: 4, sha256: "b".repeat(64), parts: [{ partNumber: 1, etag: "part-1" }] });
    expect(result.status).toBe(200);
    expect(result.body.etag).toBe("already-complete");
    expect(h.bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("isolates sessions by admin, validates resumed folder identity and signs only reserved objects", async () => {
    const h = harness(true); const session = await h.session();
    const path = `sessions/${session.sessionId}/objects`;
    const init = (await h.request(`${path}/initiate`, { clientId: "one", filename: "a.bin", sizeBytes: 4 })).body;
    const signed = await h.request(`${path}/sign`, { clientId: "one", partNumbers: [1], key: "another/key" });
    expect(signed.status).toBe(200);
    const url = new URL(signed.body.parts[0].url);
    expect(url.pathname).toBe(`/custom-games/${init.key}`);
    expect(url.searchParams.get("uploadId")).toBe(init.uploadId);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect((await h.request(`${path}/sign`, { clientId: "one", partNumbers: [2] })).status).toBe(400);
    expect((await h.request("sessions", { sessionId: session.sessionId, gameId, fingerprint: "c".repeat(64), planVersion: 2 })).status).toBe(409);
    vi.mocked(requireAdminSession).mockResolvedValue({ session: { admin_user_id: 2 } } as Awaited<ReturnType<typeof requireAdminSession>>);
    expect((await h.request(`sessions/${session.sessionId}`, undefined, "GET")).status).toBe(404);
    expect((await h.request(`${path}/sign`, { clientId: "one", partNumbers: [1] })).status).toBe(404);
  });

  it("handles empty files, rejects an unreserved final manifest and never cancels finalized objects", async () => {
    const h = harness(); const session = await h.session(); const path = `sessions/${session.sessionId}/objects`;
    const empty = await h.request(`${path}/initiate`, { clientId: "empty", filename: "empty.bin", sizeBytes: 0, sha256: emptySha });
    expect(empty.body.completed).toBe(true);
    expect(h.bucket.createMultipartUpload).not.toHaveBeenCalled();
    const nonempty = (await h.request(`${path}/initiate`, { clientId: "one", filename: "one.bin", sizeBytes: 4 })).body;
    h.multiparts.get(nonempty.uploadId)!.parts.set(1, new TextEncoder().encode("test"));
    await h.request(`${path}/complete`, { clientId: "one", sizeBytes: 4, sha256: "b".repeat(64), parts: [{ partNumber: 1, etag: "part-1" }] });
    const body = { gameId, sessionId: session.sessionId, manifestId: "22222222-2222-4222-8222-222222222222", files: [
      { key: empty.body.key, path: "empty.bin", sizeBytes: 0, sha256: emptySha },
      { key: nonempty.key, path: "one.bin", sizeBytes: 4, sha256: "b".repeat(64) },
    ], bundles: [] };
    const foreign = await h.request("folder/complete", { ...body, files: [{ ...body.files[1], key: `${gameId}/files/33333333-3333-4333-8333-333333333333` }] });
    expect(foreign.status).toBe(409);
    expect((await h.request("folder/complete", body)).status).toBe(201);
    expect((await h.request("folder/complete", body)).status).toBe(201);
    expect((await h.request(`sessions/${session.sessionId}/cancel`)).status).toBe(409);
    expect(h.objects.has(nonempty.key)).toBe(true);
    const state = await h.request(`sessions/${session.sessionId}`, undefined, "GET");
    expect(state.body.status).toBe("finalized");
    expect(state.body.manifestKey).toContain(body.manifestId);
    await cleanupExpiredGameUploads(h.bucket as unknown as R2Bucket, Date.now() + 8 * 86400_000);
    expect(h.objects.has(nonempty.key)).toBe(true);
  });

  it("cancels or expires only its own objects and aborts unfinished multipart uploads", async () => {
    const h = harness(); const first = await h.session(); const second = await h.session();
    const firstObject = (await h.request(`sessions/${first.sessionId}/objects/initiate`, { clientId: "one", filename: "one.bin", sizeBytes: 4 })).body;
    const secondObject = (await h.request(`sessions/${second.sessionId}/objects/initiate`, { clientId: "one", filename: "one.bin", sizeBytes: 4 })).body;
    const arbitrary = `${gameId}/files/55555555-5555-4555-8555-555555555555`;
    h.objects.set(arbitrary, { bytes: new Uint8Array([1]), etag: "external", size: 1 });
    expect((await h.request(`sessions/${first.sessionId}/cancel`)).status).toBe(200);
    expect(h.multiparts.has(firstObject.uploadId)).toBe(false);
    expect(h.multiparts.has(secondObject.uploadId)).toBe(true);
    expect(h.objects.has(arbitrary)).toBe(true);
    expect((await h.request(`sessions/${first.sessionId}/objects/initiate`, { clientId: "two", filename: "two.bin", sizeBytes: 4 })).status).toBe(409);
    await cleanupExpiredGameUploads(h.bucket as unknown as R2Bucket, Date.now() + 8 * 86400_000);
    expect(h.multiparts.has(secondObject.uploadId)).toBe(false);
    expect(h.objects.has(arbitrary)).toBe(true);
  });

  it("does not let expired finalizing sessions block cleanup of later abandoned sessions", async () => {
    const h = harness(); const finishing = await h.session(); const abandoned = await h.session();
    const finishingObject = (await h.request(`sessions/${finishing.sessionId}/objects/initiate`,
      { clientId: "v2:0", filename: "first.bin", sizeBytes: 4 })).body;
    const abandonedObject = (await h.request(`sessions/${abandoned.sessionId}/objects/initiate`,
      { clientId: "v2:0", filename: "second.bin", sizeBytes: 4 })).body;
    const stateKey = `_upload-sessions/${finishing.sessionId}/session.json`;
    const prior = JSON.parse(new TextDecoder().decode(h.objects.get(stateKey)!.bytes));
    await h.bucket.put(stateKey, JSON.stringify({ ...prior, status: "finalizing",
      manifestId: "22222222-2222-4222-8222-222222222222" }));
    await cleanupExpiredGameUploads(h.bucket as unknown as R2Bucket, Date.now() + 8 * 86400_000);
    expect(h.multiparts.has(finishingObject.uploadId)).toBe(true);
    expect(h.multiparts.has(abandonedObject.uploadId)).toBe(false);
    expect([...h.objects.keys()].some(key => key.startsWith("_upload-session-expiry/") && key.includes(finishing.sessionId))).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(h.objects.get(stateKey)!.bytes)).status).toBe("finalizing");
  });

  it("cleans an object initiated concurrently with cancellation instead of leaving an orphan", async () => {
    const h = harness(); const session = await h.session();
    const initialCreate = h.bucket.createMultipartUpload.getMockImplementation()!;
    let notifyCreated!: () => void;
    let resumeCreate!: () => void;
    const created = new Promise<void>(resolve => { notifyCreated = resolve; });
    const continueCreation = new Promise<void>(resolve => { resumeCreate = resolve; });
    h.bucket.createMultipartUpload.mockImplementationOnce(async key => {
      const upload = await initialCreate(key);
      notifyCreated();
      await continueCreation;
      return upload;
    });
    const initiation = h.request(`sessions/${session.sessionId}/objects/initiate`,
      { clientId: "v2:0", filename: "race.bin", sizeBytes: 4 });
    await created;
    expect((await h.request(`sessions/${session.sessionId}/cancel`)).status).toBe(200);
    resumeCreate();
    expect((await initiation).status).toBe(409);
    expect(h.multiparts.size).toBe(0);
    expect([...h.objects.keys()].some(key => key.startsWith(`${gameId}/files/`))).toBe(false);
  });
});
