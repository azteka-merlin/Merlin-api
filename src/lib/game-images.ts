import type { AppBindings, AppContext } from "../types";

export type GameImageMessage = { appId: string; generation: string };
type Trigger = "catalog" | "launcher" | "activation" | "admin";
type JobStatus = "queued" | "processing" | "stored" | "missing" | "failed";
type AssetRow = { appId: string; status: "stored"; size: number; origin: string; trigger: string; updatedAt: string };
type JobRow = Pick<Job, "appId" | "status" | "trigger" | "updatedAt" | "attempts" | "error">;
type Job = GameImageMessage & {
  status: JobStatus;
  trigger: Trigger;
  sourceUrl: string;
  updatedAt: string;
  attempts: number;
  error: string;
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const LEASE_SECONDS = 60;
const steamHosts = new Set([
  "shared.akamai.steamstatic.com", "shared.fastly.steamstatic.com",
  "cdn.cloudflare.steamstatic.com", "cdn.akamai.steamstatic.com",
  "cdn.fastly.steamstatic.com", "steamcdn-a.akamaihd.net",
]);

export function validImageAppId(value: string): boolean {
  return /^[1-9]\d{0,11}$/.test(value);
}

export function gameImagePath(appId: string): string {
  return "/api/public/game-images/" + encodeURIComponent(appId);
}

function prefix(env: AppBindings): string {
  return "game-images/v1/" + env.ENVIRONMENT + "/";
}

function imageKey(env: AppBindings, appId: string): string {
  return prefix(env) + "header/" + appId;
}

function jobKey(env: AppBindings, appId: string): string {
  return prefix(env) + "jobs/" + appId;
}

export function gameImageSource(appId: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 600 || !validImageAppId(appId)) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (steamHosts.has(url.hostname)) {
      const path = url.pathname.match(/^\/(?:store_item_assets\/steam\/|steam\/)?apps\/(\d+)\/(?:[a-f0-9]{40}\/)?(?:header|capsule_(?:184x69|231x87|467x181|616x353))(?:_[a-z-]{2,20})?\.(?:jpg|png|webp)$/i);
      if (path?.[1] !== appId) return "";
    } else if (url.hostname !== "generator.ryuu.lol" || url.pathname !== "/files/images/" + appId + ".jpg") {
      return "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function readJob(object: R2Object | null): Job | null {
  const meta = object?.customMetadata;
  if (!meta?.appId || !meta.generation || !meta.status || !meta.trigger || !meta.updatedAt) return null;
  return {
    appId: meta.appId, generation: meta.generation, status: meta.status as JobStatus,
    trigger: meta.trigger as Trigger, sourceUrl: meta.sourceUrl || "", updatedAt: meta.updatedAt,
    attempts: Number(meta.attempts) || 0, error: meta.error || "",
  };
}

function putJob(env: AppBindings, job: Job, previous: R2Object | null) {
  return env.MERLIN_FILES.put(jobKey(env, job.appId), crypto.randomUUID(), {
    onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
    customMetadata: { ...job, attempts: String(job.attempts) },
  });
}

function inactiveJob(job: Job, now = Date.now()): boolean {
  const age = now - Date.parse(job.updatedAt);
  return (job.status === "processing" && age >= LEASE_SECONDS * 1000) ||
    (job.status === "queued" && age >= 60 * 60 * 1000);
}

export async function enqueueGameImage(
  env: AppBindings, appId: string, trigger: Trigger, source?: unknown,
): Promise<"queued" | "pending" | "stored" | "cooldown" | "disabled"> {
  if (!validImageAppId(appId) || !env.GAME_IMAGE_QUEUE || !env.MERLIN_FILES) return "disabled";
  if (await env.MERLIN_FILES.head(imageKey(env, appId))) return "stored";

  const current = await env.MERLIN_FILES.head(jobKey(env, appId));
  const previous = readJob(current);
  if (previous) {
    if ((previous.status === "queued" || previous.status === "processing") && !inactiveJob(previous)) return "pending";
    const newSource = gameImageSource(appId, source);
    const previousAge = Date.now() - Date.parse(previous.updatedAt);
    const cooldown = previous.status === "missing" ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
    if (trigger !== "admin" && (previous.status === "missing" || previous.status === "failed") &&
      previousAge < cooldown && (!newSource || newSource === previous.sourceUrl)) return "cooldown";
  }

  const job: Job = {
    appId, generation: crypto.randomUUID(), status: "queued", trigger,
    sourceUrl: gameImageSource(appId, source) || previous?.sourceUrl || "",
    updatedAt: new Date().toISOString(), attempts: 0, error: "",
  };
  const claimed = await putJob(env, job, current);
  if (!claimed) return "pending";
  try {
    await env.GAME_IMAGE_QUEUE.send({ appId, generation: job.generation });
    return "queued";
  } catch (error) {
    await putJob(env, { ...job, status: "failed", error: "dispatch_failed" }, claimed).catch(() => {});
    throw error;
  }
}

export function queueGameImageInBackground(c: AppContext, appId: string, trigger: Trigger, source?: unknown) {
  if (!c.env.GAME_IMAGE_QUEUE || !validImageAppId(appId)) return;
  c.executionCtx.waitUntil(enqueueGameImage(c.env, appId, trigger, source).catch(() => {
    console.warn("[game-images] queue-dispatch-failed", { appId, trigger });
  }));
}

async function resolveSteamGameImage(appId: string): Promise<string | null> {
  const endpoint = new URL("https://store.steampowered.com/api/appdetails");
  endpoint.searchParams.set("appids", appId);
  endpoint.searchParams.set("l", "english");
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(3000),
    redirect: "manual",
    headers: { Accept: "application/json", "User-Agent": "Merlin/2.0" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error("steam_metadata_unavailable");
  }
  const result = await response.json() as Record<string, { data?: { header_image?: string; capsule_image?: string } }>;
  const data = result[appId]?.data;
  return gameImageSource(appId, data?.capsule_image) || gameImageSource(appId, data?.header_image) || null;
}

function detectedImageType(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder();
  if (bytes.length < 4) return null;
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return "image/png";
  if (decoder.decode(bytes.subarray(0, 4)) === "RIFF" && decoder.decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (decoder.decode(bytes.subarray(4, 8)) === "ftyp" && /avif|avis/.test(decoder.decode(bytes.subarray(8, 32)))) return "image/avif";
  return null;
}

async function readImage(response: Response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  const type = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (!response.body || declaredLength > MAX_IMAGE_BYTES || !type?.startsWith("image/")) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return detectedImageType(bytes) === type ? { bytes, type } : null;
}

async function downloadGameImage(appId: string, sourceUrl: string) {
  const steam = "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/" + appId + "/header.jpg";
  const ryuu = "https://generator.ryuu.lol/files/images/" + appId + ".jpg";
  const tried = new Set<string>();
  let transientFailure = false;

  async function download(url: string | null) {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000), redirect: "manual",
        headers: { Accept: "image/*", "User-Agent": "Merlin/2.0" },
      });
      if (response.ok) {
        const image = await readImage(response);
        return image ? { ...image, origin: new URL(url).hostname } : null;
      }
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500) transientFailure = true;
    } catch {
      transientFailure = true;
    }
    return null;
  }

  let image = await download(sourceUrl) || await download(steam);
  if (image) return image;
  try {
    image = await download(await resolveSteamGameImage(appId));
  } catch {
    transientFailure = true;
  }
  image ||= await download(ryuu);
  if (image) return image;
  if (transientFailure) throw new Error("source_unavailable");
  return null;
}

async function processImageMessage(message: Message<GameImageMessage>, env: AppBindings) {
  const { appId, generation } = message.body ?? {};
  if (!appId || !validImageAppId(appId) || !generation) return message.ack();
  const row = await env.MERLIN_FILES.head(jobKey(env, appId));
  const job = readJob(row);
  if (!row || !job || job.generation !== generation || !["queued", "processing"].includes(job.status)) return message.ack();
  if (job.status === "processing" && !inactiveJob(job)) {
    message.retry({ delaySeconds: LEASE_SECONDS });
    return;
  }
  const processing: Job = { ...job, status: "processing", updatedAt: new Date().toISOString(), attempts: message.attempts, error: "" };
  const lease = await putJob(env, processing, row);
  if (!lease) return message.retry({ delaySeconds: LEASE_SECONDS });
  let status: JobStatus = "stored";
  let error = "";
  try {
    const key = imageKey(env, appId);
    if (!(await env.MERLIN_FILES.head(key))) {
      const found = await downloadGameImage(appId, job.sourceUrl);
      if (!found) status = "missing";
      else await env.MERLIN_FILES.put(key, found.bytes, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: found.type },
        customMetadata: { appId, origin: found.origin, trigger: job.trigger },
      });
    }
  } catch {
    status = message.attempts < MAX_ATTEMPTS ? "queued" : "failed";
    error = "download_failed";
  }
  await putJob(env, { ...processing, status, updatedAt: new Date().toISOString(), error }, lease);
  if (status === "queued") message.retry({ delaySeconds: 30 * message.attempts });
  else message.ack();
}

export async function consumeGameImages(batch: MessageBatch<GameImageMessage>, env: AppBindings) {
  for (const message of batch.messages) {
    try {
      await processImageMessage(message, env);
    } catch {
      console.warn("[game-images] consumer-failed", { appId: message.body?.appId });
      message.retry({ delaySeconds: LEASE_SECONDS });
    }
  }
}

export async function serveGameImage(c: AppContext, headOnly: boolean) {
  const appId = c.req.param("appId") || "";
  if (!validImageAppId(appId) || !c.env.MERLIN_FILES) return c.body(null, 404);
  const request = new Request(new URL(gameImagePath(appId), c.req.url));
  const headers = { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<{ response: Response; fromStorage: boolean }> => {
    const cache = typeof caches === "undefined" ? undefined : caches.default;
    const cached = await cache?.match(request).catch(() => undefined);
    if (cached) return { response: headOnly ? new Response(null, { headers: cached.headers }) : cached, fromStorage: false };
    const key = imageKey(c.env, appId);
    const image = headOnly ? await c.env.MERLIN_FILES.head(key) : await c.env.MERLIN_FILES.get(key);
    if (!image) return { response: new Response(null, { status: 404, headers }), fromStorage: false };
    const response = new Response("body" in image ? (image as R2ObjectBody).body : null, {
      headers: {
        "Content-Type": image.httpMetadata?.contentType || "application/octet-stream",
        "Content-Length": String(image.size),
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        ETag: image.httpEtag,
      },
    });
    return { response, fromStorage: true };
  };
  const pending = read();
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), 350);
  });
  try {
    const result = await Promise.race([pending, timeout]);
    if (!result) {
      void pending.then(({ response }) => response.body?.cancel()).catch(() => {});
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const { response, fromStorage } = result;
    if (!headOnly && fromStorage && typeof caches !== "undefined") {
      c.executionCtx.waitUntil(caches.default.put(request, response.clone()).catch(() => {}));
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function listGameImages(env: AppBindings, view: "queue" | "assets", cursor?: string, appId?: string) {
  const objectPrefix = prefix(env) + (view === "assets" ? "header/" : "jobs/");
  const [page, metrics] = await Promise.all([
    appId
      ? env.MERLIN_FILES.head(objectPrefix + appId).then(object => ({ objects: object ? [object] : [], truncated: false as const }))
      : env.MERLIN_FILES.list({ prefix: objectPrefix, cursor, limit: 40, include: ["customMetadata"] }),
    env.GAME_IMAGE_QUEUE?.metrics().catch(() => null) ?? null,
  ]);
  return {
    enabled: Boolean(env.GAME_IMAGE_QUEUE),
    backlog: metrics?.backlogCount ?? null,
    oldestAt: metrics?.oldestMessageTimestamp ?? null,
    nextCursor: page.truncated ? page.cursor : null,
    rows: page.objects.flatMap<AssetRow | JobRow>(object => {
      if (view === "assets") {
        return [{
          appId: object.key.slice(objectPrefix.length), status: "stored", size: object.size,
          origin: object.customMetadata?.origin || "", trigger: object.customMetadata?.trigger || "",
          updatedAt: object.uploaded.toISOString(),
        }];
      }
      const job = readJob(object);
      if (!job) return [];
      const overdue = inactiveJob(job);
      return [{
        appId: job.appId, status: overdue ? "failed" : job.status, trigger: job.trigger,
        updatedAt: job.updatedAt, attempts: job.attempts, error: overdue ? "job_expired" : job.error,
      }];
    }),
  };
}
