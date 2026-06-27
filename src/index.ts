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
    manifestOverride: body.manifestOverride,
    fixOverride: body.fixOverride,
  });
  return c.json({ appId: body.appId, override }, 200);
});

app.post("/panel-api/overrides/upload", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const formData = await c.req.formData();
  const appId = String(formData.get("appId") || "").trim();
  const kind = String(formData.get("kind") || "").trim();
  const file = formData.get("file");

  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Informe um appId numérico válido." });
  }

  if (kind !== "manifest" && kind !== "fix") {
    throw new HTTPException(400, { message: "Tipo de upload inválido." });
  }

  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
  }

  const safeName = sanitizeOverrideFilename(file.name || "arquivo");
  const lowerName = safeName.toLowerCase();
  const isZip = lowerName.endsWith(".zip");
  const isRar = lowerName.endsWith(".rar");

  if (kind === "manifest" && !isZip) {
    throw new HTTPException(400, { message: "Manifest override aceita apenas arquivos .zip." });
  }

  if (kind === "fix" && !isZip && !isRar) {
    throw new HTTPException(400, { message: "Fix override aceita arquivos .zip ou .rar." });
  }

  const bytes = await file.arrayBuffer();
  const sizeBytes = file.size || bytes.byteLength || 0;
  if (sizeBytes <= 0) {
    throw new HTTPException(400, { message: "O arquivo enviado está vazio." });
  }

  const folder = kind === "manifest" ? "manifests" : "fixes";
  const objectKey = `${appId}/${folder}/${safeName}`;

  await c.env.MERLIN_FILES.put(objectKey, bytes, {
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












