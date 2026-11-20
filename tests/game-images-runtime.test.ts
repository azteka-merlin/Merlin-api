import { afterAll, beforeAll, expect, test } from "vitest";
import { Miniflare, Response as EdgeResponse } from "miniflare";
import { build } from "esbuild";
import { resolve } from "node:path";
import { gameImageSource } from "../src/lib/game-images";

let runtime: Miniflare;
const requests: string[] = [];
const jpeg = new Uint8Array([255, 216, 255, 217]);
let releaseSlowImage: (() => void) | undefined;

beforeAll(async () => {
  const bundle = await build({
    bundle: true, write: false, format: "esm", platform: "browser",
    stdin: { resolveDir: resolve("src/lib"), loader: "ts", contents: `
      import { consumeGameImages, enqueueGameImage, listGameImageDashboard, listGameImages, listProcessingGameImages, refreshGameImageDashboardHistory, serveGameImage, syncLegacyWaitingIndex } from "./game-images";
      import { dispatchGameImageImport, getGameImageImportProgress } from "./game-image-import";
      function context(request, env, ctx, appId) {
        return { env, executionCtx: ctx, req: { url: request.url, param() { return appId; } } };
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          const [action, appId] = url.pathname.slice(1).split("/");
          const params = url.searchParams;
          if (params.has("scale")) env = { ...env, ENVIRONMENT: "history-scale-fixture" };
          if (action === "enqueue") return Response.json(await enqueueGameImage(env, appId, "launcher", await request.text()));
          if (action === "dispatch-import") {
            await dispatchGameImageImport(env);
            return Response.json(await getGameImageImportProgress(env));
          }
          if (action === "sync-waiting") {
            await syncLegacyWaitingIndex(env);
            return Response.json({ success: true });
          }
          if (action === "refresh-history") {
            let lists = 0;
            if (params.has("scale")) {
              const bucket = env.MERLIN_FILES;
              env = { ...env, MERLIN_FILES: {
                head: key => bucket.head(key),
                put: (key, body, options) => bucket.put(key, body, options),
                list(options) {
                  lists++;
                  const start = Number(options.cursor || 0);
                  const end = Math.min(start + options.limit, 64145);
                  const objects = Array.from({ length: end - start }, (_, index) => {
                    const appId = String(100000 + start + index);
                    return { key: options.prefix + appId, customMetadata: {
                      appId, trigger: "import", generation: "fixture", attempts: "1", updatedAt: new Date().toISOString(),
                      status: (start + index) % 500 === 0 ? "missing" : "stored",
                    } };
                  });
                  return { objects, truncated: end < 64145, cursor: String(end) };
                },
              } };
            }
            await refreshGameImageDashboardHistory(env);
            return Response.json({ success: true, lists });
          }
          if (action === "dashboard") {
            let listAttempts = 0;
            let reads = 0;
            let heads = 0;
            const viewEnv = { ...env, MERLIN_FILES: {
              list(options) {
                listAttempts++;
                if (!options.prefix.endsWith("/waiting/")) throw new Error("Unexpected reconstruction during dashboard request");
                if (params.has("throttle") && listAttempts <= 2) throw new Error("list: Reduce your concurrent request rate for the same object. (10058)");
                return env.MERLIN_FILES.list(options);
              },
              get(key) { reads++; return env.MERLIN_FILES.get(key); },
              head(key) { heads++; return env.MERLIN_FILES.head(key); },
              delete(keys) { return env.MERLIN_FILES.delete(keys); },
            } };
            const data = await listGameImageDashboard(context(request, viewEnv, ctx), { view: appId, page: Number(params.get("page") || 1), appId: params.get("appId") || undefined });
            return Response.json(data, { headers: {
              "test-list-attempts": String(listAttempts), "test-history-reads": String(reads), "test-heads": String(heads),
            } });
          }
          if (action === "processing") return Response.json(await listProcessingGameImages(context(request, env, ctx)));
          if (action === "list") return Response.json(await listGameImages(env, appId, undefined, new URL(request.url).searchParams.get("appId") || undefined));
          return await serveGameImage(context(request, env, ctx, appId), request.method === "HEAD");
        },
        queue(batch, env) { return consumeGameImages(batch, env); },
      };
    ` },
  });
  runtime = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-06-20",
    bindings: { ENVIRONMENT: "staging" }, r2Buckets: ["MERLIN_FILES"], d1Databases: ["merlin_db"],
    queueProducers: { GAME_IMAGE_QUEUE: "merlin-game-images-staging" },
    queueConsumers: { "merlin-game-images-staging": { maxBatchSize: 1, maxBatchTimeout: 0 } },
    outboundService: async request => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/30/header.jpg")) {
        await new Promise<void>(resolve => { releaseSlowImage = resolve; });
        return new EdgeResponse(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      }
      if (url.pathname.endsWith("/10/header.jpg")) return new EdgeResponse(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      if (url.pathname.endsWith("/20/header.jpg")) return new EdgeResponse("HTML pretending to be a photo", { headers: { "Content-Type": "image/jpeg" } });
      if (url.hostname === "store.steampowered.com") return new EdgeResponse("{}", { headers: { "Content-Type": "application/json" } });
      return new EdgeResponse(null, { status: 404 });
    },
  });
  const db = await runtime.getD1Database("merlin_db");
  await db.prepare("CREATE TABLE games_catalog (app_id TEXT PRIMARY KEY, name TEXT)").run();
  await db.prepare("CREATE TABLE catalog_games (app_id TEXT PRIMARY KEY, name TEXT)").run();
  await db.prepare("INSERT INTO games_catalog VALUES ('30', 'Synthetic slow game')").run();
});

afterAll(async () => { await runtime?.dispose(); });

function send(path: string, init?: RequestInit) {
  return runtime.dispatchFetch("http://localhost" + path, init as Parameters<Miniflare["dispatchFetch"]>[1]);
}

async function waitForJob(appId: string, status: string) {
  const deadline = Date.now() + 6500;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const response = await send("/list/queue?appId=" + appId);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Array<{ status: string; appId: string }> };
    lastStatus = JSON.stringify(body.rows[0]);
    if (body.rows[0]?.status === status) return body.rows[0];
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for " + status + " for AppID " + appId + ": " + lastStatus + " · " + requests.join(", "));
}

test("origin hints must match a permitted HTTPS game image and the same AppID", () => {
  const valid = "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/10/header.jpg";
  expect(gameImageSource("10", valid + "?t=123#preview")).toBe(valid);
  expect(gameImageSource("11", valid)).toBe("");
  expect(gameImageSource("10", "https://other.test/steam/apps/10/header.jpg")).toBe("");
  expect(gameImageSource("10", "https://steamstatic.com.other.test/steam/apps/10/header.jpg")).toBe("");
  expect(gameImageSource("10", "https://generator.ryuu.lol/secure_download/10.jpg")).toBe("");
});

test("concurrent reports produce one background download and the bytes become public inside the isolated Worker", async () => {
  expect((await send("/image/10")).status).toBe(404);
  const reports = await Promise.all(Array.from({ length: 6 }, () => send("/enqueue/10", { method: "POST" })));
  const outcomes = await Promise.all(reports.map(response => response.json()));
  expect(outcomes.filter(outcome => outcome === "queued")).toHaveLength(1);
  await waitForJob("10", "stored");
  const image = await send("/image/10");
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(jpeg);
  expect((await send("/image/10", { method: "HEAD" })).status).toBe(200);
  expect(await (await send("/enqueue/10", { method: "POST" })).json()).toBe("stored");
  expect(requests.filter(url => url.includes("/10/header.jpg"))).toHaveLength(1);

  const bucket = await runtime.getR2Bucket("MERLIN_FILES");
  expect(await bucket.head("game-images/v1/staging/header/10")).not.toBeNull();
  expect(await bucket.head("game-images/v1/production/header/10")).toBeNull();
});

test("a response declared as JPEG with invalid bytes is never stored and repeated reports cool down", async () => {
  expect(await (await send("/enqueue/20", { method: "POST" })).json()).toBe("queued");
  await waitForJob("20", "missing");
  expect((await send("/image/20")).status).toBe(404);
  expect(await (await send("/enqueue/20", { method: "POST" })).json()).toBe("cooldown");
}, 12000);

test("history queries stay bounded after indexing 64,145 synthetic AppIDs", async () => {
  const bucket = await runtime.getR2Bucket("MERLIN_FILES");
  const prefix = "game-images/v1/history-scale-fixture/";
  await Promise.all(Array.from({ length: 5 }, (_, index) => bucket.put(prefix + "header/" + (164140 + index), jpeg)));

  expect(await (await send("/refresh-history?scale=1")).json()).toMatchObject({ lists: 130 });
  const assetHistory = await bucket.head(prefix + "indexes/history-v1/completed.json");
  expect(assetHistory?.size).toBeLessThan(600_000);

  const failures = await send("/dashboard/failed?scale=1&page=7");
  expect(failures.headers.get("test-list-attempts")).toBe("0");
  expect(failures.headers.get("test-history-reads")).toBe("1");
  expect(failures.headers.get("test-heads")).toBe("0");
  expect(await failures.json()).toMatchObject({ total: 129, page: 7, rows: Array(9).fill(expect.objectContaining({ status: "missing" })) });

  const images = await send("/dashboard/completed?scale=1&page=3208");
  expect(images.headers.get("test-list-attempts")).toBe("0");
  expect(images.headers.get("test-history-reads")).toBe("1");
  expect(images.headers.get("test-heads")).toBe("5");
  expect(await images.json()).toMatchObject({ total: 64145, page: 3208, rows: Array(5).fill(expect.objectContaining({ status: "stored" })) });
});

test("the processing view shows a live download independently of history and clears completed tasks", async () => {
  expect(await (await send("/enqueue/30", { method: "POST" })).json()).toBe("queued");
  const deadline = Date.now() + 5000;
  try {
    while (!releaseSlowImage) {
      if (Date.now() >= deadline) throw new Error("Image download did not start");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const response = await send("/processing");
    expect(response.status).toBe(200);
    const data = await response.json() as { rows: Array<{ appId: string; name: string; trigger: string; attempts: number }> };
    expect(data.rows).toMatchObject([{ appId: "30", name: "Synthetic slow game", trigger: "launcher", attempts: 1 }]);
    expect(data.rows).toHaveLength(1);
  } finally {
    releaseSlowImage?.();
  }
  await waitForJob("30", "stored");
  const data = await (await send("/processing")).json() as { rows: unknown[] };
  expect(data.rows).toEqual([]);
}, 10000);

test("bulk upload advances bounded R2 slices, counts existing assets and only uses Steam for imported images", async () => {
  const bucket = await runtime.getR2Bucket("MERLIN_FILES");
  const games = Array.from({ length: 61 }, (_, i) => ({ appId: String(200 + i) }));
  const id = "synthetic-plan";
  const key = "game-images/v1/staging/imports/";
  await bucket.put(key + id + "/games.ndjson", games.map(game => JSON.stringify(game)).join("\n") + "\n");
  await bucket.put(key + "current.json", JSON.stringify({
    id, total: games.length, processed: 0, queued: 0, stored: 0, pending: 0,
    offset: 0, leaseUntil: 0, status: "running", updatedAt: new Date().toISOString(),
  }));
  for (const game of games.slice(0, 60)) await bucket.put("game-images/v1/staging/header/" + game.appId, jpeg);
  const first = await send("/dispatch-import", { method: "POST" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ status: "running", processed: 60, stored: 60, queued: 0 });
  const second = await send("/dispatch-import", { method: "POST" });
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ status: "completed", processed: 61, stored: 60, queued: 1 });
  await waitForJob("260", "missing");
  expect(requests.some(url => url.includes("/260/header.jpg"))).toBe(true);
  expect(requests.some(url => url.includes("generator.ryuu.lol/files/images/260.jpg"))).toBe(false);
}, 12000);

test("dashboard isolates queued, processing and completed records and jumps directly to numbered pages", async () => {
  const bucket = await runtime.getR2Bucket("MERLIN_FILES");
  const prefix = "game-images/v1/staging/";
  const now = new Date().toISOString();
  function putJob(appId: string, status: string, updatedAt = now) {
    return bucket.put(prefix + "jobs/" + appId, appId, { customMetadata: {
      appId, generation: "seed-" + appId, trigger: "admin", status, updatedAt, attempts: "1",
    } });
  }
  for (let id = 500; id < 545; id++) await putJob(String(id), "queued");
  await putJob("555", "processing");
  await putJob("556", "failed");
  await putJob("557", "queued", "2025-01-01T00:00:00.000Z");
  for (let id = 600; id < 735; id++) await bucket.put(prefix + "header/" + id, jpeg);

  expect((await send("/sync-waiting")).status).toBe(200);
  const firstResponse = await send("/dashboard/queued?page=1&throttle=1");
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get("test-list-attempts")).toBe("3");
  const first = await firstResponse.json() as { rows: Array<{ appId: string; status: string }>; total: number; page: number };
  expect(first.total).toBe(45);
  expect(first.rows).toHaveLength(20);
  expect(first.rows.every(row => row.status === "queued")).toBe(true);
  const last = await (await send("/dashboard/queued?page=3")).json() as typeof first;
  expect(last.page).toBe(3);
  expect(last.rows.map(row => row.appId)).toEqual(["540", "541", "542", "543", "544"]);
  expect((await (await send("/dashboard/queued?appId=555")).json() as typeof first).total).toBe(0);
  expect((await (await send("/dashboard/failed?appId=556")).json() as typeof first).rows[0]?.status).toBe("failed");
  expect((await (await send("/dashboard/failed?appId=557")).json() as typeof first).rows[0]?.status).toBe("failed");

  expect(await (await send("/dashboard/failed")).json()).toMatchObject({ preparing: true });
  expect(await (await send("/dashboard/completed")).json()).toMatchObject({ preparing: true });
  await Promise.all([send("/refresh-history"), send("/refresh-history")]);
  const failedResponse = await send("/dashboard/failed");
  expect(failedResponse.headers.get("test-list-attempts")).toBe("0");
  expect(failedResponse.headers.get("test-history-reads")).toBe("1");
  expect(failedResponse.headers.get("test-heads")).toBe("0");
  const failed = await failedResponse.json() as typeof first & { updatedAt: string };
  expect(failed.updatedAt).toBeTruthy();
  expect(failed.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ appId: "556", status: "failed" }),
    expect.objectContaining({ appId: "557", status: "failed", error: "job_expired" }),
  ]));
  const completeResponse = await send("/dashboard/completed?page=5");
  expect(completeResponse.headers.get("test-list-attempts")).toBe("0");
  expect(completeResponse.headers.get("test-history-reads")).toBe("1");
  expect(completeResponse.headers.get("test-heads")).toBe("20");
  const complete = await completeResponse.json() as typeof first;
  expect(complete.total).toBeGreaterThanOrEqual(135);
  expect(complete.page).toBe(5);
  expect(complete.rows).toHaveLength(20);
  expect(complete.rows.every(row => row.status === "stored")).toBe(true);
  const historyKey = prefix + "indexes/history-v1/completed.json";
  const snapshot = await bucket.head(historyKey);
  await send("/refresh-history");
  expect(await bucket.head(historyKey)).toMatchObject({ etag: snapshot?.etag, uploaded: snapshot?.uploaded });
}, 12000);
