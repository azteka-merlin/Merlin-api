import { fromHono } from "chanfana";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AdminCreateLicenseRoute } from "./endpoints/admin-create-license";
import { AdminDeleteOverrideRoute } from "./endpoints/admin-delete-override";
import { AdminGetLicenseRoute } from "./endpoints/admin-get-license";
import { AdminListLicensesRoute } from "./endpoints/admin-list-licenses";
import { AdminListOverridesRoute } from "./endpoints/admin-list-overrides";
import { AdminRenewLicenseRoute } from "./endpoints/admin-renew-license";
import { AdminResetHwidRoute } from "./endpoints/admin-reset-hwid";
import { AdminRevokeLicenseRoute } from "./endpoints/admin-revoke-license";
import { AdminUpsertOverrideRoute } from "./endpoints/admin-upsert-override";
import { FixesCatalogRoute } from "./endpoints/fixes-catalog";
import { FixesDownloadRoute } from "./endpoints/fixes-download";
import { HealthRoute } from "./endpoints/health";
import { LoginRoute } from "./endpoints/login";
import { ManifestsRoute } from "./endpoints/manifests";
import { VersionRoute } from "./endpoints/version";
import {
  buildCsrfToken,
  clearAdminSessionCookie,
  loginAdminUser,
  logoutAdminSession,
  logoutAdminSessionByToken,
  readAdminSession,
  readAdminSessionByToken,
  requireAdminSession,
  requireInternalAdminSecret,
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
import { type AppBindings, CreateLicenseRequest, RenewLicenseRequest, RevokeLicenseRequest } from "./types";
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

function sessionPayload(sessionResult: Awaited<ReturnType<typeof readAdminSessionByToken>>) {
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

function extractBearerToken(c: any) {
  const header = c.req.header("authorization");
  if (!header) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  return token;
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

async function handleProtectedPage(c: any) {
  const session = await readAdminSession(c, { touch: true, rotate: false });
  if (!session) {
    clearAdminSessionCookie(c);
    return c.redirect("/login", 302);
  }

  setAdminSessionCookie(c, session.token, session.cookieMaxAge);
  return servePanelApp(c);
}

app.get("/login", async (c) => {
  const session = await readAdminSession(c, { touch: true, rotate: false });
  if (session) {
    setAdminSessionCookie(c, session.token, session.cookieMaxAge);
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
  const session = await readAdminSession(c, { touch: true, rotate: false });
  if (!session) {
    clearAdminSessionCookie(c);
    return c.json({ success: false, error: "Sessao expirada. Faca login novamente." }, 401);
  }

  setAdminSessionCookie(c, session.token, session.cookieMaxAge);
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

app.post("/api/admin/auth/login", async (c) => {
  requireInternalAdminSecret(c);
  const body = parseBody(adminLoginSchema, await c.req.json());
  const session = await loginAdminUser(c, body.username, body.password, { rememberMe: body.rememberMe });
  return c.json({ success: true, ...sessionPayload(session), sessionToken: session.token }, 200);
});

app.get("/api/admin/auth/session", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: false });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  return c.json({ success: true, ...sessionPayload(session) }, 200);
});

app.post("/api/admin/auth/refresh", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: true });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  return c.json({ success: true, ...sessionPayload(session), sessionToken: session.token }, 200);
});

app.post("/api/admin/auth/logout", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  await logoutAdminSessionByToken(c, token);
  return c.json({ success: true }, 200);
});

app.get("/api/admin/user-activity", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: false });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const limit = Number(c.req.query("limit") || "100");
  const action = c.req.query("action")?.trim() || undefined;
  const status = c.req.query("status")?.trim() || undefined;
  const search = c.req.query("search")?.trim() || undefined;
  const logs = await listUserActivityLogs(c, { limit, action, status, search });
  return c.json({ success: true, logs }, 200);
});
app.get("/api/admin/audit-logs", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: false });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const limit = Number(c.req.query("limit") || "100");
  const adminUserIdRaw = c.req.query("adminUserId");
  const adminUserId = adminUserIdRaw && /^\d+$/.test(adminUserIdRaw) ? Number(adminUserIdRaw) : null;
  const action = c.req.query("action")?.trim() || undefined;
  const search = c.req.query("search")?.trim() || undefined;
  const logs = await listAdminAuditLogs(c, { limit, adminUserId, action, search });
  return c.json({ success: true, logs }, 200);
});
app.get("/api/admin/security/blocked-ips", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: false });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const includeHistory = c.req.query("includeHistory") === "true";
  const blockedIps = await listBlockedIps(c, includeHistory);
  return c.json({ success: true, blockedIps }, 200);
});

app.post("/api/admin/security/blocked-ips/:id/unblock", async (c) => {
  requireInternalAdminSecret(c);
  const token = extractBearerToken(c);
  const session = await readAdminSessionByToken(c, token, { touch: true, rotate: false });
  if (!session) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ success: false, error: "Invalid blocked IP id" }, 400);
  }

  const blockedIp = await unblockBlockedIp(c, id, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });

  return c.json({ success: true, blockedIp }, 200);
});
openapi.get("/api/health", HealthRoute);
openapi.get("/api/version", VersionRoute);
openapi.get("/api/manifests", ManifestsRoute);
openapi.get("/api/fixes/catalog", FixesCatalogRoute);
openapi.get("/api/fixes/download", FixesDownloadRoute);
openapi.post("/api/auth/login", LoginRoute);
openapi.get("/api/admin/licenses", AdminListLicensesRoute);
openapi.post("/api/admin/licenses", AdminCreateLicenseRoute);
openapi.get("/api/admin/licenses/:id", AdminGetLicenseRoute);
openapi.post("/api/admin/licenses/:id/renew", AdminRenewLicenseRoute);
openapi.post("/api/admin/licenses/:id/revoke", AdminRevokeLicenseRoute);
openapi.post("/api/admin/licenses/:id/reset-hwid", AdminResetHwidRoute);
openapi.get("/api/admin/overrides", AdminListOverridesRoute);
openapi.post("/api/admin/overrides", AdminUpsertOverrideRoute);
openapi.delete("/api/admin/overrides/:appId", AdminDeleteOverrideRoute);

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












