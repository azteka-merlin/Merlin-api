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
      import { consumeGameImages, enqueueGameImage, listGameImages, listProcessingGameImages, serveGameImage } from "./game-images";
      function context(request, env, ctx, appId) {
        return { env, executionCtx: ctx, req: { url: request.url, param() { return appId; } } };
      }
      export default {
        async fetch(request, env, ctx) {
          const [action, appId] = new URL(request.url).pathname.slice(1).split("/");
          if (action === "enqueue") return Response.json(await enqueueGameImage(env, appId, "launcher", await request.text()));
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
