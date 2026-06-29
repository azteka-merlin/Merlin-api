import { fromHono } from "chanfana";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { FixesCatalogRoute } from "./endpoints/fixes-catalog";
import { FixesDownloadRoute } from "./endpoints/fixes-download";
import { FixesVoteRoute } from "./endpoints/fixes-vote";
import { HealthRoute } from "./endpoints/health";
import { LoginRoute } from "./endpoints/login";
import { ManifestsRoute } from "./endpoints/manifests";
import { VersionRoute } from "./endpoints/version";
import {
  clearAdminSessionCookie,
  loginAdminUser,
  logoutAdminSession,
  type AuthSessionResult,
  readAdminSession,
  requireAdminSession,
  SESSION_COOKIE_NAME,
  setAdminSessionCookie,
} from "./lib/admin-security";
import {
  createLicense,
  getLicense,
  listLicenses,
  mapLicense,
  renewLicense,
  resetLicenseHwid,
  revokeLicense,
  reactivateLicense,
  updateLicense,
} from "./lib/admin-license-service";
import { deleteOverride, readOverrides, upsertOverride } from "./lib/overrides";
import { verifyAccessToken } from "./lib/auth";
import { type AppBindings, CreateLicenseRequest, OverrideUpsertRequest, RenewLicenseRequest, RevokeLicenseRequest } from "./types";
import { listAdminAuditLogs } from "./lib/admin-audit-service";
import { listBlockedIps, unblockBlockedIp } from "./lib/admin-blocked-ip-service";
import { listUserActivityLogs } from "./lib/user-activity-service";

const app = new Hono<{ Bindings: AppBindings }>();

app.use("*", async (c, next) => {
  await next();

  const isSwaggerRoute = c.req.path === "/doc" || c.req.path.startsWith("/doc/") || c.req.path.startsWith("/openapi.json");
  const csp = isSwaggerRoute
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https://fastly.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

  const headers = new Headers(c.res.headers);
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "accelerometer=(), autoplay=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()");

  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

const openapi = fromHono(app, {
  docs_url: "/doc",
  schema: {
    info: {
      title: "Merlin API",
      version: "1.0.0",
    },
  },
});

openapi.registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API Token",
});

const pageRoutes = ["/", "/licenses", "/activity", "/audit", "/overrides", "/settings"] as const;
const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});
const updateLicenseSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hwid: z.string().trim().optional().nullable(),
});
const overrideUploadInitSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  kind: z.enum(["manifest", "fix"]),
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
const merlinUpdateUploadInitSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
const overrideUploadAbortSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  kind: z.enum(["manifest", "fix"]),
  uploadId: z.string().min(1),
  objectKey: z.string().min(1),
});
const merlinUpdateUploadAbortSchema = z.object({
  uploadId: z.string().min(1),
  objectKey: z.string().min(1),
});
const overrideUploadCompleteSchema = overrideUploadAbortSchema.extend({
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  uploadedParts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      etag: z.string().min(1),
    }),
  ).min(1),
});
const merlinUpdateUploadCompleteSchema = merlinUpdateUploadAbortSchema.extend({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  uploadedParts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      etag: z.string().min(1),
    }),
  ).min(1),
});

function jsonError(message: string, status = 400) {
  return new Response(
    JSON.stringify({
      success: false,
      error: message,
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function getPanelIndexRequest(c: any) {
  return new Request(new URL("/index.html", c.req.url).toString(), { method: "GET" });
}

async function servePanelApp(c: any) {
  return c.env.ASSETS.fetch(getPanelIndexRequest(c));
}

function sessionPayload(sessionResult: AuthSessionResult | null) {
  if (!sessionResult) {
    return null;
  }

  return {
    authenticated: true,
    admin: {
      id: sessionResult.session.admin_user_id,
      username: sessionResult.session.username,
      role: sessionResult.session.role,
    },
    csrfToken: sessionResult.csrfToken,
    expiresAt: sessionResult.expiresAt,
    absoluteExpiresAt: sessionResult.absoluteExpiresAt,
  };
}

function parseBody<T>(schema: z.ZodSchema<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "Invalid request payload" });
  }
  return parsed.data;
}

function parseLicenseId(raw: string) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new HTTPException(400, { message: "Invalid license id" });
  }
  return value;
}

function sanitizeOverrideFilename(fileName: string) {
  const normalized = String(fileName || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() || "";

  const safe = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  if (!safe) {
    throw new HTTPException(400, { message: "Invalid file name" });
  }

  return safe;
}

function detectUploadContentType(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".rar")) return "application/vnd.rar";
  return "application/octet-stream";
}

function formatUploadSize(bytes: number) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

const OVERRIDE_UPLOAD_PART_SIZE = 16 * 1024 * 1024;
const MERLIN_UPDATE_OBJECT_KEY = "_updates/Merlin-Setup-latest.exe";
const MERLIN_UPDATE_LATEST_JSON_KEY = "_updates/latest.json";
const PUBLIC_UPDATE_LATEST_URL = "https://api-merlin.com/api/updates/latest";
const PUBLIC_UPDATE_DOWNLOAD_URL = "https://api-merlin.com/api/updates/download";

function resolveOverrideUploadTarget(appId: string, kind: "manifest" | "fix", uploadName: string) {
  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Informe um appId numerico valido." });
  }

  const safeName = sanitizeOverrideFilename(uploadName);
  const lowerName = safeName.toLowerCase();
  const isZip = lowerName.endsWith(".zip");
  const isRar = lowerName.endsWith(".rar");

  if (kind === "manifest" && !isZip) {
    throw new HTTPException(400, { message: "Manifest override aceita apenas arquivos .zip." });
  }

  if (kind === "fix" && !isZip && !isRar) {
    throw new HTTPException(400, { message: "Fix override aceita arquivos .zip ou .rar." });
  }

  const folder = kind === "manifest" ? "manifests" : "fixes";
  return {
    safeName,
    folder,
    objectKey: `${appId}/${folder}/${safeName}`,
  };
}

function sanitizeMerlinUpdateFilename(fileName: string) {
  const safeName = sanitizeOverrideFilename(fileName);
  if (!/\.exe$/i.test(safeName)) {
    throw new HTTPException(400, { message: "O instalador do Merlin deve ser um arquivo .exe." });
  }
  return safeName;
}

function buildMerlinUpdateMetadata(version: string, filename: string, sizeBytes: number) {
  return {
    version,
    filename,
    sizeBytes,
    sizeLabel: formatUploadSize(sizeBytes),
    objectKey: MERLIN_UPDATE_OBJECT_KEY,
    latestUrl: PUBLIC_UPDATE_LATEST_URL,
    downloadUrl: PUBLIC_UPDATE_DOWNLOAD_URL,
    publishedAt: new Date().toISOString(),
  };
}

async function readMerlinUpdateMetadata(env: AppBindings) {
  const object = await env.MERLIN_FILES.get(MERLIN_UPDATE_LATEST_JSON_KEY);
  if (!object) return null;

  const raw = await object.text();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.version !== "string" || typeof parsed.downloadUrl !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function validateOverrideUploadObjectKey(appId: string, kind: "manifest" | "fix", objectKey: string) {
  const normalized = String(objectKey || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("..") || normalized.startsWith("/")) {
    throw new HTTPException(400, { message: "Invalid override object key" });
  }

  const folder = kind === "manifest" ? "manifests" : "fixes";
  const expectedPrefix = `${appId}/${folder}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new HTTPException(400, { message: "Invalid override object key" });
  }

  const safeName = sanitizeOverrideFilename(normalized);
  const canonical = `${expectedPrefix}${safeName}`;
  if (canonical !== normalized) {
    throw new HTTPException(400, { message: "Invalid override object key" });
  }

  return resolveOverrideUploadTarget(appId, kind, safeName);
}

async function handleProtectedPage(c: any) {
  const session = await readAdminSession(c, { touch: false, rotate: false });
  if (!session) {
    clearAdminSessionCookie(c);
    return c.redirect("/login", 302);
  }

  return servePanelApp(c);
}

app.get("/login", async (c) => {
  const session = await readAdminSession(c, { touch: false, rotate: false });
  if (session) {
    return c.redirect("/", 302);
  }

  clearAdminSessionCookie(c);
  return servePanelApp(c);
});

for (const route of pageRoutes) {
  app.get(route, handleProtectedPage);
}

app.post("/panel-api/auth/login", async (c) => {
  try {
    const body = parseBody(adminLoginSchema, await c.req.json());
    const session = await loginAdminUser(c, body.username, body.password, { rememberMe: body.rememberMe });
    setAdminSessionCookie(c, session.token, session.cookieMaxAge);
    return c.json(sessionPayload(session), 200);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ success: false, error: "Informe usuario e senha." }, 400);
    }
    if (error instanceof HTTPException && error.status === 401) {
      clearAdminSessionCookie(c);
      return c.json({ success: false, error: "Usuario ou senha invalidos." }, 401);
    }
    throw error;
  }
});

app.get("/panel-api/auth/session", async (c) => {
  const session = await readAdminSession(c, { touch: false, rotate: false });
  if (!session) {
    clearAdminSessionCookie(c);
    return c.json({ success: false, error: "Sessao expirada. Faca login novamente." }, 401);
  }

  return c.json(sessionPayload(session), 200);
});

app.post("/panel-api/auth/logout", async (c) => {
  try {
    await requireAdminSession(c, { mutate: true });
  } catch {
    clearAdminSessionCookie(c);
    return c.json({ success: true }, 200);
  }

  await logoutAdminSession(c);
  return c.json({ success: true }, 200);
});

app.get("/panel-api/user-activity", async (c) => {
  await requireAdminSession(c);
  const limit = Number(c.req.query("limit") || "100");
  const action = c.req.query("action")?.trim() || undefined;
  const status = c.req.query("status")?.trim() || undefined;
  const search = c.req.query("search")?.trim() || undefined;
  const logs = await listUserActivityLogs(c, { limit, action, status, search });
  return c.json({ logs }, 200);
});
app.get("/panel-api/audit-logs", async (c) => {
  await requireAdminSession(c);
  const limit = Number(c.req.query("limit") || "100");
  const adminUserIdRaw = c.req.query("adminUserId");
  const adminUserId = adminUserIdRaw && /^\d+$/.test(adminUserIdRaw) ? Number(adminUserIdRaw) : null;
  const action = c.req.query("action")?.trim() || undefined;
  const search = c.req.query("search")?.trim() || undefined;
  const logs = await listAdminAuditLogs(c, { limit, adminUserId, action, search });
  return c.json({ logs }, 200);
});
app.get("/panel-api/security/blocked-ips", async (c) => {
  await requireAdminSession(c);
  const includeHistory = c.req.query("includeHistory") === "true";
  const blockedIps = await listBlockedIps(c, includeHistory);
  return c.json({ blockedIps }, 200);
});

app.post("/panel-api/security/blocked-ips/:id/unblock", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "Invalid blocked IP id" });
  }

  const unblocked = await unblockBlockedIp(c, id, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });

  return c.json({ blockedIp: unblocked }, 200);
});
app.get("/panel-api/overrides", async (c) => {
  await requireAdminSession(c);
  const overrides = await readOverrides(c.env);
  return c.json({ overrides }, 200);
});

app.post("/panel-api/overrides", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(OverrideUpsertRequest, await c.req.json());
  const override = await upsertOverride(c.env, body.appId, {
    name: body.name,
    adminNote: body.adminNote,
    manifestOverride: body.manifestOverride,
    fixOverride: body.fixOverride,
  });
  return c.json({ appId: body.appId, override }, 200);
});

app.post("/panel-api/overrides/upload/initiate", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const body = parseBody(overrideUploadInitSchema, await c.req.json());
  const target = resolveOverrideUploadTarget(body.appId, body.kind, body.filename);

  const upload = await c.env.MERLIN_FILES.createMultipartUpload(target.objectKey, {
    httpMetadata: {
      contentType: detectUploadContentType(target.safeName),
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    appId: body.appId,
    kind: body.kind,
    uploadId: upload.uploadId,
    path: target.objectKey,
    filename: target.safeName,
    partSize: OVERRIDE_UPLOAD_PART_SIZE,
    sizeBytes: body.sizeBytes,
    sizeLabel: formatUploadSize(body.sizeBytes),
  }, 200);
});

app.post("/panel-api/overrides/upload/part", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const appId = String(c.req.query("appId") || "").trim();
  const kind = String(c.req.query("kind") || "").trim();
  const uploadId = String(c.req.query("uploadId") || "").trim();
  const objectKey = String(c.req.query("objectKey") || "").trim();
  const partNumber = Number(c.req.query("partNumber") || "0");

  if ((kind !== "manifest" && kind !== "fix") || !uploadId || !Number.isInteger(partNumber) || partNumber <= 0) {
    throw new HTTPException(400, { message: "Invalid multipart upload request" });
  }

  const target = validateOverrideUploadObjectKey(appId, kind, objectKey);
  const body = c.req.raw.body;
  if (!body) {
    throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
  }

  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(target.objectKey, uploadId);
  const uploadedPart = await upload.uploadPart(partNumber, body);
  return c.json(uploadedPart, 200);
});

app.post("/panel-api/overrides/upload/complete", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const body = parseBody(overrideUploadCompleteSchema, await c.req.json());
  const target = validateOverrideUploadObjectKey(body.appId, body.kind, body.objectKey);

  if (target.safeName !== resolveOverrideUploadTarget(body.appId, body.kind, body.filename).safeName) {
    throw new HTTPException(400, { message: "Invalid override file name" });
  }

  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(target.objectKey, body.uploadId);
  const uploadedParts = [...body.uploadedParts].sort((left, right) => left.partNumber - right.partNumber);
  await upload.complete(uploadedParts);

  return c.json({
    success: true,
    appId: body.appId,
    kind: body.kind,
    path: target.objectKey,
    filename: target.safeName,
    sizeBytes: body.sizeBytes,
    sizeLabel: formatUploadSize(body.sizeBytes),
  }, 200);
});

app.post("/panel-api/overrides/upload/abort", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const body = parseBody(overrideUploadAbortSchema, await c.req.json());
  const target = validateOverrideUploadObjectKey(body.appId, body.kind, body.objectKey);
  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(target.objectKey, body.uploadId);
  await upload.abort();

  return c.json({ success: true }, 200);
});

app.post("/panel-api/overrides/upload", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const contentType = c.req.header("content-type") || "";
  let appId = "";
  let kind = "";
  let uploadName = "arquivo";
  let sizeBytes = 0;
  let uploadBody: ReadableStream | ArrayBuffer | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");

    appId = String(formData.get("appId") || "").trim();
    kind = String(formData.get("kind") || "").trim();

    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
    }

    uploadName = file.name || "arquivo";
    sizeBytes = file.size || 0;
    uploadBody = await file.arrayBuffer();
  } else {
    appId = String(c.req.query("appId") || "").trim();
    kind = String(c.req.query("kind") || "").trim();
    uploadName = c.req.header("x-upload-filename") || "arquivo";

    const headerSize = Number(c.req.header("x-upload-size") || c.req.header("content-length") || "0");
    sizeBytes = Number.isFinite(headerSize) ? headerSize : 0;
    uploadBody = c.req.raw.body;

    if (!uploadBody) {
      throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
    }
  }

  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Informe um appId numerico valido." });
  }

  if (kind !== "manifest" && kind !== "fix") {
    throw new HTTPException(400, { message: "Tipo de upload invalido." });
  }

  const safeName = sanitizeOverrideFilename(uploadName);
  const lowerName = safeName.toLowerCase();
  const isZip = lowerName.endsWith(".zip");
  const isRar = lowerName.endsWith(".rar");

  if (kind === "manifest" && !isZip) {
    throw new HTTPException(400, { message: "Manifest override aceita apenas arquivos .zip." });
  }

  if (kind === "fix" && !isZip && !isRar) {
    throw new HTTPException(400, { message: "Fix override aceita arquivos .zip ou .rar." });
  }

  if (sizeBytes <= 0) {
    throw new HTTPException(400, { message: "O arquivo enviado esta vazio." });
  }

  const folder = kind === "manifest" ? "manifests" : "fixes";
  const objectKey = `${appId}/${folder}/${safeName}`;

  await c.env.MERLIN_FILES.put(objectKey, uploadBody, {
    httpMetadata: {
      contentType: detectUploadContentType(safeName),
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    appId,
    kind,
    path: objectKey,
    filename: safeName,
    sizeBytes,
    sizeLabel: formatUploadSize(sizeBytes),
  }, 200);
});

app.get("/panel-api/overrides/download", async (c) => {
  await requireAdminSession(c);

  const appId = String(c.req.query("appId") || "").trim();
  const kind = String(c.req.query("kind") || "").trim();

  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Invalid appId" });
  }

  if (kind !== "manifest" && kind !== "fix") {
    throw new HTTPException(400, { message: "Invalid override kind" });
  }

  const overrides = await readOverrides(c.env);
  const entry = overrides[appId];
  if (!entry) {
    throw new HTTPException(404, { message: "Override not found" });
  }

  const filePath = kind === "manifest"
    ? entry.manifestOverride?.file
    : entry.fixOverride?.file;

  if (!filePath) {
    throw new HTTPException(404, { message: "Override file not found" });
  }

  const object = await c.env.MERLIN_FILES.get(filePath);
  if (!object) {
    throw new HTTPException(404, { message: "Stored override file not found" });
  }

  const downloadName = sanitizeOverrideFilename(
    kind === "fix"
      ? entry.fixOverride?.filename || filePath.split("/").filter(Boolean).pop() || `${appId}.zip`
      : filePath.split("/").filter(Boolean).pop() || `${appId}.zip`
  );

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  } else {
    headers.set("Content-Type", detectUploadContentType(downloadName));
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);

  return new Response(object.body, {
    status: 200,
    headers,
  });
});

app.get("/api/updates/latest", async (c) => {
  const latest = await readMerlinUpdateMetadata(c.env);
  if (!latest) {
    return c.json({ success: false }, 404);
  }

  return c.json({
    success: true,
    version: latest.version,
    filename: latest.filename,
    sizeBytes: latest.sizeBytes || 0,
    sizeLabel: latest.sizeLabel || formatUploadSize(Number(latest.sizeBytes) || 0),
    downloadUrl: latest.downloadUrl || PUBLIC_UPDATE_DOWNLOAD_URL,
    publishedAt: latest.publishedAt || null,
  }, 200);
});

app.get("/api/updates/download", async (c) => {
  const latest = await readMerlinUpdateMetadata(c.env);
  if (!latest) {
    throw new HTTPException(404, { message: "Update not found" });
  }

  const object = await c.env.MERLIN_FILES.get(MERLIN_UPDATE_OBJECT_KEY);
  if (!object) {
    throw new HTTPException(404, { message: "Stored update file not found" });
  }

  const downloadName = sanitizeMerlinUpdateFilename(latest.filename || `Merlin-Setup-${latest.version || "latest"}.exe`);
  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  } else {
    headers.set("Content-Type", "application/vnd.microsoft.portable-executable");
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);

  return new Response(object.body, {
    status: 200,
    headers,
  });
});

app.get("/panel-api/updates", async (c) => {
  await requireAdminSession(c);
  const latest = await readMerlinUpdateMetadata(c.env);
  return c.json({ update: latest }, 200);
});

app.post("/panel-api/updates/upload/initiate", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(merlinUpdateUploadInitSchema, await c.req.json());
  const safeName = sanitizeMerlinUpdateFilename(body.filename);

  const upload = await c.env.MERLIN_FILES.createMultipartUpload(MERLIN_UPDATE_OBJECT_KEY, {
    httpMetadata: {
      contentType: "application/vnd.microsoft.portable-executable",
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    version: body.version,
    uploadId: upload.uploadId,
    objectKey: MERLIN_UPDATE_OBJECT_KEY,
    filename: safeName,
    partSize: OVERRIDE_UPLOAD_PART_SIZE,
    sizeBytes: body.sizeBytes,
    sizeLabel: formatUploadSize(body.sizeBytes),
  }, 200);
});

app.post("/panel-api/updates/upload/part", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const uploadId = String(c.req.query("uploadId") || "").trim();
  const objectKey = String(c.req.query("objectKey") || "").trim();
  const partNumber = Number(c.req.query("partNumber") || "0");

  if (!uploadId || !Number.isInteger(partNumber) || partNumber <= 0) {
    throw new HTTPException(400, { message: "Invalid multipart upload request" });
  }
  if (objectKey !== MERLIN_UPDATE_OBJECT_KEY) {
    throw new HTTPException(400, { message: "Invalid update upload target" });
  }

  const body = c.req.raw.body;
  if (!body) {
    throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
  }

  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(MERLIN_UPDATE_OBJECT_KEY, uploadId);
  const uploadedPart = await upload.uploadPart(partNumber, body);
  return c.json(uploadedPart, 200);
});

app.post("/panel-api/updates/upload/complete", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(merlinUpdateUploadCompleteSchema, await c.req.json());

  if (body.objectKey !== MERLIN_UPDATE_OBJECT_KEY) {
    throw new HTTPException(400, { message: "Invalid update upload target" });
  }

  const safeName = sanitizeMerlinUpdateFilename(body.filename);
  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(MERLIN_UPDATE_OBJECT_KEY, body.uploadId);
  const uploadedParts = [...body.uploadedParts].sort((left, right) => left.partNumber - right.partNumber);
  await upload.complete(uploadedParts);

  const metadata = buildMerlinUpdateMetadata(body.version, safeName, body.sizeBytes);
  await c.env.MERLIN_FILES.put(MERLIN_UPDATE_LATEST_JSON_KEY, JSON.stringify(metadata, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    update: metadata,
  }, 200);
});

app.post("/panel-api/updates/upload/abort", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(merlinUpdateUploadAbortSchema, await c.req.json());
  if (body.objectKey !== MERLIN_UPDATE_OBJECT_KEY) {
    throw new HTTPException(400, { message: "Invalid update upload target" });
  }

  const upload = c.env.MERLIN_FILES.resumeMultipartUpload(MERLIN_UPDATE_OBJECT_KEY, body.uploadId);
  await upload.abort();

  return c.json({ success: true }, 200);
});

app.delete("/panel-api/overrides/:appId", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const appId = c.req.param("appId");
  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Invalid appId" });
  }

  const deleted = await deleteOverride(c.env, appId);
  if (!deleted) {
    throw new HTTPException(404, { message: "Override not found" });
  }

  return c.json({ success: true, appId }, 200);
});

app.get("/panel-api/licenses", async (c) => {
  await requireAdminSession(c);
  const licenses = await listLicenses(c);
  return c.json({ licenses }, 200);
});

app.get("/panel-api/licenses/:id", async (c) => {
  await requireAdminSession(c);
  const license = await getLicense(c, parseLicenseId(c.req.param("id")));
  return c.json(mapLicense(license), 200);
});

app.post("/panel-api/licenses", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const body = parseBody(CreateLicenseRequest, await c.req.json());
  const created = await createLicense(c, body, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(created), 201);
});

app.put("/panel-api/licenses/:id", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const body = parseBody(updateLicenseSchema, await c.req.json());
  const updated = await updateLicense(c, parseLicenseId(c.req.param("id")), {
    ...body,
    hwid: body.hwid ?? null,
  }, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

app.post("/panel-api/licenses/:id/renew", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const body = parseBody(RenewLicenseRequest, await c.req.json());
  const updated = await renewLicense(c, parseLicenseId(c.req.param("id")), body.expiresAt, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

app.post("/panel-api/licenses/:id/revoke", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const body = parseBody(RevokeLicenseRequest, await c.req.json());
  const updated = await revokeLicense(c, parseLicenseId(c.req.param("id")), body.reason, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

app.post("/panel-api/licenses/:id/reactivate", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const updated = await reactivateLicense(c, parseLicenseId(c.req.param("id")), {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

app.post("/panel-api/licenses/:id/reset-hwid", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const updated = await resetLicenseHwid(c, parseLicenseId(c.req.param("id")), {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

openapi.get("/api/health", HealthRoute);
openapi.get("/api/version", VersionRoute);
app.get("/api/manifests/status", async (c) => {
  const authorization = c.req.header("authorization") || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new HTTPException(401, { message: "Missing access token" });
  }

  if (!c.env.JWT_SECRET) {
    throw new HTTPException(500, { message: "JWT secret is not configured" });
  }

  const payload = await verifyAccessToken(token, c.env.JWT_SECRET);
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HTTPException(401, { message: "Access token expired" });
  }

  const license = await c.env.merlin_db
    .prepare(`
      SELECT id, hwid, expires_at, status
      FROM licenses
      WHERE id = ?
    `)
    .bind(payload.sub)
    .first<{ id: number; hwid: string | null; expires_at: string; status: "active" | "revoked" }>();

  if (!license) {
    throw new HTTPException(401, { message: "License not found" });
  }
  if (license.status !== "active") {
    throw new HTTPException(401, { message: "License is not active" });
  }
  if (!license.hwid || license.hwid !== payload.hwid) {
    throw new HTTPException(401, { message: "HWID mismatch" });
  }

  const expiresAt = new Date(license.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new HTTPException(401, { message: "License expired" });
  }

  const appId = String(c.req.query("appid") || "").trim();
  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Invalid appid" });
  }

  const overrides = await readOverrides(c.env);
  const requiresVersionPin = Boolean(overrides[appId]?.manifestOverride?.enabled);

  return c.json({
    success: true,
    appId,
    requiresVersionPin,
  }, 200);
});

openapi.get("/api/manifests", ManifestsRoute);
openapi.get("/api/fixes/catalog", FixesCatalogRoute);
openapi.get("/api/fixes/download", FixesDownloadRoute);
openapi.post("/api/fixes/vote", FixesVoteRoute);
openapi.post("/api/auth/login", LoginRoute);

app.onError((error, c) => {
  console.error("[merlin-api:error]", error);
  if (error instanceof HTTPException) {
    return c.json({ success: false, error: error.message }, error.status);
  }

  return c.json({ success: false, error: "Internal Server Error" }, 500);
});

app.notFound((c) => {
  const url = new URL(c.req.url);
  const { pathname } = url;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/panel-api/") ||
    pathname.startsWith("/doc") ||
    pathname.startsWith("/openapi")
  ) {
    return c.json(
      {
        success: false,
        error: "Not Found",
      },
      404,
    );
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;












