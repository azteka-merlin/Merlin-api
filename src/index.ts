import { fromHono } from "chanfana";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { FixesCatalogRoute } from "./endpoints/fixes-catalog";
import { FixesDownloadRoute } from "./endpoints/fixes-download";
import { FixesVoteRoute } from "./endpoints/fixes-vote";
import { GamesSearchRoute } from "./endpoints/games-search";
import { HealthRoute } from "./endpoints/health";
import { LoginRoute } from "./endpoints/login";
import { ManifestsRoute } from "./endpoints/manifests";
import { PublicEmailVerificationStartRoute, PublicEmailVerificationVerifyRoute } from "./endpoints/public-email-verification";
import { VersionRoute } from "./endpoints/version";
import {
  clearAdminSessionCookie,
  getClientIp,
  loginAdminUser,
  logoutAdminSession,
  requireInternalAdminSecret,
  type AuthSessionResult,
  readAdminSession,
  requireAdminSession,
  SESSION_COOKIE_NAME,
  setAdminSessionCookie,
  writeAdminAuditLog,
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
import { getBillingSettings, updateBillingSettings } from "./lib/billing-settings";
import { createLauncherBillingPortalSession, createPublicBillingPortalSession } from "./lib/billing-portal";
import { listAdminPaymentLogs } from "./lib/admin-payment-service";
import { deleteOverride, readOverrides, upsertOverride } from "./lib/overrides";
import { createPublicAccessBillingPortal, createPublicAccessUpgradeCheckout, getPublicAccessDetails, getPublicAccessUpgradeStatus } from "./lib/public-access-management";
import { createPublicStripeCheckout } from "./lib/public-checkout";
import {
  getPublicCheckoutStatus,
  getPublicCheckoutStatusByEmail,
  parseAndVerifyStripeWebhook,
  processStripeWebhookEvent,
  reconcileStripeCheckoutSession,
  reconcileStripeLicense,
} from "./lib/stripe-webhook";
import { requireLauncherLicense } from "./lib/launcher-auth";
import { type AppBindings, type AppContext, CreateLicenseRequest, OverrideUpsertRequest, RenewLicenseRequest, RevokeLicenseRequest } from "./types";
import { listAdminAuditLogs } from "./lib/admin-audit-service";
import { isValidRecoverySecret } from "./lib/recovery-pin";
import {
  assertPremiumDownloadAccess,
  assertPremiumActivationReservationForLicense,
  completePremiumActivation,
  completePremiumActivationForLicense,
  createPremiumGame,
  deletePremiumGame,
  failPremiumActivationReservation,
  failPremiumActivationReservationForLicense,
  findPremiumActivationReservationForLicense,
  getPremiumGame,
  listPremiumCatalog,
  listPremiumGames,
  requireAuthenticatedPremiumLicense,
  reservePremiumActivation,
  updatePremiumGame,
} from "./lib/premium-games";
import {
  createPoll,
  deletePoll,
  listActivePolls,
  listPolls,
  setPollStatus,
  updatePoll,
  votePoll,
} from "./lib/polls";
import { listBlockedIps, unblockBlockedIp } from "./lib/admin-blocked-ip-service";
import { listUserActivityLogs, writeUserActivityLog } from "./lib/user-activity-service";
import { enforcePublicAccessKeyRateLimit } from "./lib/rate-limit";
import { sendRecoveredAccessKeyEmail, sendWelcomeAccessKeyEmail } from "./lib/access-key-emails";
import {
  getPublicSignupMetrics,
  getPublicSignupSettings,
  getPublicSignupSettingsPayload,
  normalizePublicAccessContact,
  recoverPublicAccessKey,
  registerPublicAccessKey,
  updatePublicSignupSettings,
} from "./lib/public-access-keys";

const app = new Hono<{ Bindings: AppBindings }>();

app.use("*", async (c, next) => {
  await next();

  const isSwaggerRoute = c.req.path === "/doc" || c.req.path.startsWith("/doc/") || c.req.path.startsWith("/openapi.json");
  const isPublicDownloadRoute = c.req.path === "/" || c.req.path === "/download" || c.req.path === "/download/";
  const csp = isSwaggerRoute
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https://fastly.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    : isPublicDownloadRoute
      ? "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com"
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

const pageRoutes = ["/overview", "/licenses", "/activity", "/audit", "/overrides", "/premium", "/polls", "/payments", "/settings", "/public-signup"] as const;
const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});
const recoverySecretSchema = z.string().trim().refine(isValidRecoverySecret, {
  message: "Use 4 a 8 numeros ou uma senha com 4 a 8 letras/numeros.",
});
const updateLicenseSchema = z.object({
  name: z.string().min(1),
  contact: z.string().min(1).optional(),
  contactType: z.enum(["phone", "email", "discord"]).optional().default("phone"),
  phone: z.string().min(1).optional(),
  recoveryPin: recoverySecretSchema.optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hwid: z.string().trim().optional().nullable(),
}).refine((value) => Boolean(value.contact || value.phone), {
  message: "Contact is required",
  path: ["contact"],
});
const publicAccessKeySchema = z.object({
  name: z.string().trim().min(1),
  contact: z.string().trim().min(1),
  contactType: z.literal("email"),
  recoveryPin: recoverySecretSchema,
  acceptedRecoveryNotice: z.boolean(),
});

async function handleStripeWebhook(c: AppContext) {
  const rawBody = await c.req.text();
  const event = await parseAndVerifyStripeWebhook(c, rawBody);
  const result = await processStripeWebhookEvent(c, event);
  return c.json({ received: true, ...result }, 200);
}
const publicAccessKeyRecoverySchema = z.object({
  contact: z.string().trim().min(1),
  contactType: z.literal("email"),
  recoveryPin: recoverySecretSchema,
});
const publicSignupSettingsSchema = z.object({
  enabled: z.boolean(),
  durationAmount: z.number().int().positive().optional().default(30),
  durationUnit: z.enum(["days", "weeks", "months", "years"]).optional().default("days"),
  isLifetime: z.boolean(),
  billing: z.object({
    billingEnabled: z.boolean(),
    monthlyEnabled: z.boolean(),
    lifetimeEnabled: z.boolean(),
    monthlyPriceId: z.string().trim().optional().default(""),
    lifetimePriceId: z.string().trim().optional().default(""),
  }).optional(),
});
const publicCheckoutSchema = z.object({
  name: z.string().trim().min(1),
  contact: z.string().trim().email(),
  recoveryPin: recoverySecretSchema,
  acceptedRecoveryNotice: z.boolean(),
  planType: z.enum(["monthly", "lifetime"]),
});
const publicCheckoutStatusQuerySchema = z.object({
  session_id: z.string().trim().min(1),
});
const publicCheckoutStatusByEmailSchema = z.object({
  email: z.string().trim().email(),
});
const publicBillingPortalSchema = z.object({
  email: z.string().trim().email(),
});
const publicAccessMeSchema = z.object({
  email: z.string().trim().email(),
  recoveryPin: recoverySecretSchema,
});
const publicAccessUpgradeStatusQuerySchema = z.object({
  session_id: z.string().trim().min(1),
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
const premiumGameUploadInitSchema = z.object({
  appId: z.string().regex(/^\d+$/),
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
const premiumGameUploadAbortSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  uploadId: z.string().min(1),
  objectKey: z.string().min(1),
});
const activationGenerateSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  steamAccountId: z.string().regex(/^\d+$/).optional(),
});
const activationDownloadQuerySchema = z.object({
  appid: z.string().regex(/^\d+$/),
});
const premiumActivationRequestSchema = z.object({
  appId: z.string().regex(/^\d+$/),
});
const premiumThirdPartyActivationRequestSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  reservationId: z.number().int().positive().optional(),
  tokenReq: z.string().trim().min(1),
});
const premiumActivationEventSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  reservationId: z.number().int().positive().optional(),
  activationType: z.enum(["steam_ticket", "third_party"]).optional(),
  stage: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().max(1000).optional(),
  cooldownApplied: z.boolean().optional(),
});
const premiumGameCreateSchema = z.object({
  appId: z.string().regex(/^\d+$/),
  name: z.string().min(1).optional(),
  coverUrl: z.string().url().nullable().optional(),
  archiveKey: z.string().min(1).optional(),
  installSubpath: z.string().min(1).optional(),
  activationType: z.enum(["steam_ticket", "third_party"]).optional(),
  launchExecutablePath: z.string().min(1).nullable().optional(),
  activationLimit: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});
const premiumGameUpdateSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  coverUrl: z.string().url().nullable().optional(),
  archiveKey: z.string().min(1).nullable().optional(),
  installSubpath: z.string().min(1).nullable().optional(),
  activationType: z.enum(["steam_ticket", "third_party"]).nullable().optional(),
  launchExecutablePath: z.string().min(1).nullable().optional(),
  activationLimit: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one premium game field must be provided",
});
const pollOptionSchema = z.object({
  label: z.string().trim().min(1),
  gameAppId: z.string().trim().regex(/^\d+$/).nullable().optional(),
});
const pollContributionOptionSchema = z.object({
  label: z.string().trim().min(1),
  minAmount: z.number().int().nonnegative().nullable().optional(),
  maxAmount: z.number().int().nonnegative().nullable().optional(),
});
const pollUpsertSchema = z.object({
  type: z.enum(["basic", "game_request"]),
  question: z.string().trim().min(1),
  status: z.enum(["draft", "open", "closed"]).optional(),
  currencyCode: z.string().trim().regex(/^[A-Za-z]{3}$/).nullable().optional(),
  options: z.array(pollOptionSchema).min(2).max(3),
  contributionOptions: z.array(pollContributionOptionSchema).max(4).nullable().optional(),
});
const pollVoteSchema = z.object({
  optionId: z.number().int().positive().nullable().optional(),
  contributionOptionId: z.number().int().positive().nullable().optional(),
  contributionSkipped: z.boolean().nullable().optional(),
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
const premiumGameUploadCompleteSchema = premiumGameUploadAbortSchema.extend({
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

function getActivationAssetKey(appId: string) {
  return `${appId}/${appId}.zip`;
}

function getActivationDownloadPath(appId: string) {
  return `/api/activations/download?appid=${encodeURIComponent(appId)}`;
}

function getActivationDownloadUrl(c: any, appId: string) {
  return new URL(getActivationDownloadPath(appId), c.req.url).toString();
}

function getPremiumDownloadPath(appId: string) {
  return `/api/premium/download?appid=${encodeURIComponent(appId)}`;
}

function getPremiumDownloadUrl(c: any, appId: string) {
  return new URL(getPremiumDownloadPath(appId), c.req.url).toString();
}

function getActivationPayload(worker: { payload: unknown } | null, appId: string, steamAccountId: string, c: any) {
  const payload = worker && typeof worker.payload === "object" && worker.payload !== null
    ? worker.payload as Record<string, unknown>
    : null;
  const parsed = payload && typeof payload.parsed === "object" && payload.parsed !== null
    ? payload.parsed as Record<string, unknown>
    : null;

  return {
    appId,
    steamAccountId,
    steamId: typeof parsed?.steamId === "string" ? parsed.steamId : null,
    configSteamUserId: typeof parsed?.configSteamUserId === "string"
      ? parsed.configSteamUserId
      : steamAccountId,
    ticket: typeof parsed?.ticket === "string" ? parsed.ticket : null,
    configIni: typeof payload?.configIni === "string" ? payload.configIni : null,
    archiveFileName: `${appId}.zip`,
    archiveKey: getActivationAssetKey(appId),
    archiveDownloadPath: getActivationDownloadPath(appId),
    archiveDownloadUrl: getActivationDownloadUrl(c, appId),
  };
}

function getPremiumActivationPayload(
  worker: { payload: unknown } | null,
  appId: string,
  steamAccountId: string,
  archiveKey: string,
  c: any,
) {
  const payload = worker && typeof worker.payload === "object" && worker.payload !== null
    ? worker.payload as Record<string, unknown>
    : null;
  const parsed = payload && typeof payload.parsed === "object" && payload.parsed !== null
    ? payload.parsed as Record<string, unknown>
    : null;

  return {
    appId,
    steamAccountId,
    steamId: typeof parsed?.steamId === "string" ? parsed.steamId : null,
    configSteamUserId: typeof parsed?.configSteamUserId === "string"
      ? parsed.configSteamUserId
      : steamAccountId,
    ticket: typeof parsed?.ticket === "string" ? parsed.ticket : null,
    configIni: typeof payload?.configIni === "string" ? payload.configIni : null,
    archiveFileName: `${appId}.zip`,
    archiveKey,
    archiveDownloadPath: getPremiumDownloadPath(appId),
    archiveDownloadUrl: getPremiumDownloadUrl(c, appId),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function getErrorStatus(error: unknown) {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : null;
  return status;
}

function getPremiumWorkerLogPayload(worker: { status: number; ok: boolean; payload: unknown; error: unknown } | null) {
  if (!worker) return null;
  const payload = worker.payload && typeof worker.payload === "object" && !Array.isArray(worker.payload)
    ? worker.payload as Record<string, unknown>
    : null;

  return {
    status: worker.status,
    ok: worker.ok,
    message: typeof payload?.message === "string" ? payload.message : null,
    jobId: typeof payload?.jobId === "string" ? payload.jobId : null,
    exitCode: typeof payload?.exitCode === "number" ? payload.exitCode : null,
    killed: typeof payload?.killed === "boolean" ? payload.killed : null,
    signal: typeof payload?.signal === "string" ? payload.signal : null,
    stdout: typeof payload?.stdout === "string" ? payload.stdout.slice(0, 2000) : null,
    stderr: typeof payload?.stderr === "string" ? payload.stderr.slice(0, 2000) : null,
    error: worker.error,
  };
}

async function writePremiumActivityLog(
  c: any,
  license: { id: number; licenseKey: string; name: string; hwid: string },
  input: {
    action: "premium_activation_success" | "premium_activation_failed";
    status: "success" | "denied";
    appId: string;
    gameName?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  try {
    await writeUserActivityLog(c, {
      licenseId: license.id,
      licenseKey: license.licenseKey,
      userName: license.name,
      action: input.action,
      status: input.status,
      appId: input.appId,
      gameName: input.gameName ?? null,
      ipAddress: getClientIp(c),
      hwid: license.hwid,
      reason: input.reason ?? null,
      metadata: {
        source: "premium",
        ...(input.metadata || {}),
      },
    });
  } catch (error) {
    console.warn("[premium-activity] failed to write user activity log:", getErrorMessage(error));
  }
}

async function callMerlinWorker(c: any, appId: string, steamAccountId: string) {
  const baseUrl = String(c.env.MERLIN_WORKER_URL || "").trim().replace(/\/$/, "");
  const workerToken = String(c.env.MERLIN_WORKER_TOKEN || "").trim();

  if (!baseUrl) {
    throw new HTTPException(500, { message: "MERLIN_WORKER_URL is not configured" });
  }

  if (!workerToken) {
    throw new HTTPException(500, { message: "MERLIN_WORKER_TOKEN is not configured" });
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/ticket-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ appId: Number(appId), steamAccountId }),
    });
  } catch (error) {
    throw new HTTPException(502, {
      message: `Could not reach Merlin worker: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }

  const rawText = await response.text();
  let payload: unknown = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText || null;
  }

  const upstreamBodyPreview = rawText && rawText.length > 1000
    ? rawText.slice(0, 1000) + "..."
    : rawText || null;

  return {
    status: response.status,
    ok: response.ok,
    payload,
    error: response.ok
      ? null
      : {
          message: `Merlin worker returned HTTP ${response.status}`,
          upstreamStatus: response.status,
          upstreamStatusText: response.statusText || null,
          upstreamBody: upstreamBodyPreview,
          upstreamServer: response.headers.get("server"),
          upstreamCfRay: response.headers.get("cf-ray"),
    },
  };
}

async function callMerlinWorkerThirdPartyToken(c: any, tokenReq: string) {
  const baseUrl = String(c.env.MERLIN_WORKER_URL || "").trim().replace(/\/$/, "");
  const workerToken = String(c.env.MERLIN_WORKER_TOKEN || "").trim();

  if (!baseUrl) {
    throw new HTTPException(500, { message: "MERLIN_WORKER_URL is not configured" });
  }

  if (!workerToken) {
    throw new HTTPException(500, { message: "MERLIN_WORKER_TOKEN is not configured" });
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/token-jobs-third-party`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ tokenReq }),
    });
  } catch (error) {
    throw new HTTPException(502, {
      message: `Could not reach Merlin worker: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }

  const rawText = await response.text();
  let payload: unknown = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText || null;
  }

  const upstreamBodyPreview = rawText && rawText.length > 1000
    ? rawText.slice(0, 1000) + "..."
    : rawText || null;

  return {
    status: response.status,
    ok: response.ok,
    payload,
    error: response.ok
      ? null
      : {
          message: `Merlin worker returned HTTP ${response.status}`,
          upstreamStatus: response.status,
          upstreamStatusText: response.statusText || null,
          upstreamBody: upstreamBodyPreview,
          upstreamServer: response.headers.get("server"),
          upstreamCfRay: response.headers.get("cf-ray"),
        },
  };
}

function getPanelIndexRequest(c: any) {
  return new Request(new URL("/index.html", c.req.url).toString(), { method: "GET" });
}

async function servePanelApp(c: any) {
  const response = await c.env.ASSETS.fetch(getPanelIndexRequest(c));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function servePublicDownloadApp(c: any) {
  const requestUrl = new URL(c.req.url);
  const shouldUseMerlinPublic = requestUrl.hostname === "api-merlin.com"
    || requestUrl.hostname === "staging.api-merlin.com"
    || c.env.ENVIRONMENT === "staging";

  if (!shouldUseMerlinPublic) {
    return c.html(renderPublicDownloadPage(), 200, {
      "cache-control": "no-store",
      "x-merlin-public-bridge": "legacy-fallback",
    });
  }

  return c.html(renderMerlinPublicDownloadShell(), 200, {
    "cache-control": "no-store",
    "x-merlin-public-bridge": "merlin-public-shell",
  });
}

function renderMerlinPublicDownloadShell() {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Merlin - Seu próximo jogo começa aqui</title>
    <meta name="description" content="Plataforma para PC com acesso a uma biblioteca de jogos e grandes lançamentos por uma assinatura que cabe no bolso." />
    <meta property="og:title" content="Merlin - Seu próximo jogo começa aqui" />
    <meta property="og:description" content="Acesse uma biblioteca com grandes jogos e lançamentos através do launcher do Merlin." />
    <link rel="icon" href="/download-assets/favicon.ico" sizes="any" />
    <link rel="icon" href="/download-assets/icons/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/download-assets/apple-touch-icon.png" />
    <script type="module" crossorigin src="/download-assets/assets/app.js"></script>
    <link rel="stylesheet" crossorigin href="/download-assets/assets/app.css" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
}

function renderPublicDownloadPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Merlin - Download</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: #eef2ff; background: radial-gradient(circle at 16% 5%, rgba(139, 92, 246, .28), transparent 32%), radial-gradient(circle at 86% 24%, rgba(47, 125, 246, .18), transparent 28%), #070b15; }
    main { width: min(1120px, calc(100% - 32px)); min-height: 100vh; margin: 0 auto; padding: 38px 0 24px; display: grid; grid-template-rows: 1fr auto; gap: 28px; align-items: center; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(380px, 440px); gap: 26px; align-items: center; }
    .hero.signup-closed { grid-template-columns: minmax(0, 720px); justify-content: center; }
    .panel { border: 1px solid rgba(139, 92, 246, .42); background: linear-gradient(180deg, rgba(15, 23, 42, .92), rgba(8, 13, 26, .94)); border-radius: 20px; box-shadow: 0 24px 90px rgba(0,0,0,.38); }
    .intro { padding: 38px; min-height: 560px; display: flex; flex-direction: column; justify-content: center; }
    .intro-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 26px; }
    .brand { display: inline-flex; align-items: center; gap: 12px; margin-bottom: 26px; color: #c4b5fd; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; font-size: 13px; }
    .intro-top .brand { margin-bottom: 0; }
    .logo { width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center; background: linear-gradient(135deg, rgba(139,92,246,.34), rgba(47,125,246,.22)); border: 1px solid rgba(196,181,253,.38); color: #fff; font-size: 23px; line-height: 1; }
    .language-select { height: 38px; min-width: 116px; border: 1px solid rgba(148,163,184,.2); background: rgba(2,6,23,.54); color: #e5e7eb; border-radius: 10px; padding: 0 10px; font: inherit; font-size: 13px; font-weight: 850; outline: none; cursor: pointer; }
    .language-select:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,.18); }
    .intro h1 { margin: 0 0 14px; font-size: clamp(42px, 6vw, 76px); line-height: .94; letter-spacing: 0; }
    .intro p { margin: 0; color: #cbd5e1; font-size: 18px; line-height: 1.6; max-width: 620px; }
    .hero-art { width: 100%; height: 230px; margin: 28px 0 0; border-radius: 18px; object-fit: cover; object-position: center; border: 1px solid rgba(139,92,246,.3); box-shadow: 0 18px 46px rgba(0,0,0,.32); background: rgba(2,6,23,.42); }
    .signup-closed .hero-art { height: 300px; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
    .button { border: 0; border-radius: 11px; padding: 12px 17px; color: white; font-weight: 900; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 44px; font: inherit; transition: transform .16s ease, border-color .16s ease, opacity .16s ease; }
    .button:hover { transform: translateY(-1px); }
    .button:disabled { cursor: not-allowed; opacity: .72; transform: none; }
    .button.primary { background: linear-gradient(135deg, #8b5cf6, #2f7df6); box-shadow: 0 16px 34px rgba(47,125,246,.22); }
    .button.download { min-height: 52px; padding: 14px 22px; font-size: 16px; }
    .button.ghost { background: rgba(255,255,255,.075); border: 1px solid rgba(255,255,255,.12); }
    .button.subtle { color: #cbd5e1; background: transparent; border: 1px solid rgba(148,163,184,.16); }
    .version { margin-top: 18px; color: #b6c2d4; font-size: 13px; font-weight: 700; }
    .benefits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 26px; padding-top: 22px; border-top: 1px solid rgba(148,163,184,.13); }
    .benefit { display: flex; align-items: center; gap: 11px; min-height: 48px; padding: 11px 12px; color: #dbeafe; font-size: 14px; line-height: 1.25; font-weight: 850; border: 1px solid rgba(148,163,184,.12); border-radius: 13px; background: rgba(2,6,23,.34); }
    .benefit span:first-child { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center; background: rgba(139,92,246,.2); color: #c4b5fd; font-size: 12px; }
    .faq { margin-top: 18px; padding-top: 20px; border-top: 1px solid rgba(148,163,184,.13); }
    .faq h2 { margin: 0 0 12px; color: #fff; font-size: 20px; line-height: 1.2; letter-spacing: 0; }
    .faq-list { display: grid; gap: 9px; }
    .faq-item { border: 1px solid rgba(148,163,184,.12); border-radius: 13px; background: rgba(2,6,23,.34); overflow: hidden; }
    .faq-question { width: 100%; min-height: 46px; padding: 12px 13px; border: 0; background: transparent; color: #dbeafe; display: flex; align-items: center; justify-content: space-between; gap: 12px; font: inherit; font-size: 14px; line-height: 1.25; font-weight: 900; text-align: left; cursor: pointer; }
    .faq-question:hover { background: rgba(139,92,246,.09); }
    .faq-question span:first-child { min-width: 0; }
    .faq-question span:last-child { flex: 0 0 auto; color: #c4b5fd; font-size: 18px; line-height: 1; transition: transform .16s ease; }
    .faq-item.is-open .faq-question span:last-child { transform: rotate(45deg); }
    .faq-answer { display: none; padding: 0 13px 13px; color: #a8b3c7; font-size: 13px; line-height: 1.55; font-weight: 680; }
    .faq-item.is-open .faq-answer { display: block; }
    .faq-answer p { margin: 0; color: inherit; font: inherit; max-width: none; }
    .card { padding: 28px; }
    .form-title { margin: 0 0 4px; color: #fff; font-size: 24px; line-height: 1.12; letter-spacing: 0; }
    .form-panel { display: grid; gap: 15px; }
    .plan-selector { display: grid; gap: 10px; }
    .plan-selector__title { margin: 0; color: #dbeafe; font-size: 13px; font-weight: 900; }
    .plan-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .plan-option { position: relative; display: grid; gap: 5px; min-height: 92px; padding: 13px 13px 12px; border: 1px solid rgba(148,163,184,.16); border-radius: 13px; background: rgba(2,6,23,.5); cursor: pointer; transition: border-color .16s ease, background .16s ease, transform .16s ease; }
    .plan-option:hover { transform: translateY(-1px); border-color: rgba(139,92,246,.48); background: rgba(139,92,246,.12); }
    .plan-option.is-selected { border-color: rgba(139,92,246,.72); background: rgba(139,92,246,.2); }
    .plan-option input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .plan-option strong { color: #fff; font-size: 15px; line-height: 1.2; }
    .plan-option span { color: #c4b5fd; font-size: 14px; font-weight: 950; overflow-wrap: anywhere; }
    .plan-option small { color: #a8b3c7; font-size: 11px; font-weight: 760; }
    .field { display: grid; gap: 7px; color: #dbeafe; font-size: 13px; font-weight: 850; }
    .input-wrap { position: relative; }
    .input-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; display: grid; place-items: center; color: #9ca3af; pointer-events: none; }
    input { width: 100%; height: 42px; border: 1px solid rgba(148,163,184,.22); background: rgba(2,6,23,.72); color: #f8fafc; border-radius: 10px; padding: 10px 12px 10px 42px; outline: none; font: inherit; font-weight: 750; }
    input:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,.18); }
    .segment { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; padding: 5px; border-radius: 13px; background: rgba(2,6,23,.54); border: 1px solid rgba(148,163,184,.13); }
    .segment button { height: 37px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #94a3b8; font: inherit; font-weight: 900; cursor: pointer; }
    .segment button.active { color: #fff; border-color: rgba(139,92,246,.62); background: rgba(139,92,246,.23); }
    .hint { color: #a8b3c7; line-height: 1.45; font-size: 12px; font-weight: 650; margin: 0; }
    .support-links { display: grid; gap: 8px; padding-top: 2px; text-align: center; }
    .text-link { width: 100%; min-height: 30px; border: 0; padding: 0; background: transparent; color: #c4b5fd; font: inherit; font-size: 13px; line-height: 1.35; font-weight: 850; cursor: pointer; text-decoration: none; }
    .text-link:hover { color: #fff; text-decoration: underline; text-underline-offset: 3px; }
    .notice { display: flex; gap: 10px; align-items: flex-start; color: #dbeafe; font-size: 12px; line-height: 1.45; padding: 12px; border-radius: 12px; background: rgba(139,92,246,.13); border: 1px solid rgba(139,92,246,.28); font-weight: 760; }
    .notice input { width: 18px; height: 18px; margin: 1px 0 0; padding: 0; accent-color: #8b5cf6; flex: 0 0 auto; }
    .field-error { min-height: 16px; color: #fca5a5; font-size: 12px; font-weight: 850; }
    .message { min-height: 18px; color: #fca5a5; font-size: 13px; font-weight: 850; }
    .message.ok { color: #86efac; }
    .status-modal { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 18px; }
    .status-modal__backdrop { position: absolute; inset: 0; background: rgba(2,6,23,.72); backdrop-filter: blur(10px); }
    .status-modal__panel { position: relative; width: min(100%, 390px); display: grid; gap: 14px; padding: 24px; border-radius: 18px; border: 1px solid rgba(148,163,184,.18); background: linear-gradient(180deg, rgba(15,23,42,.98), rgba(2,6,23,.98)); box-shadow: 0 28px 80px rgba(0,0,0,.44); text-align: center; }
    .status-modal__mark { width: 52px; height: 52px; margin: 0 auto; border-radius: 999px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #8b5cf6, #2f7df6); font-weight: 950; font-size: 20px; box-shadow: 0 16px 34px rgba(47,125,246,.2); }
    .status-modal.is-ok .status-modal__mark { background: linear-gradient(135deg, #22c55e, #2f7df6); }
    .status-modal.is-warn .status-modal__mark { background: linear-gradient(135deg, #f59e0b, #8b5cf6); }
    .status-modal.is-error .status-modal__mark { background: linear-gradient(135deg, #ef4444, #8b5cf6); }
    .status-modal h2 { margin: 0; color: #fff; font-size: 24px; line-height: 1.12; letter-spacing: 0; }
    .status-modal p { margin: 0; color: #a8b3c7; font-size: 13px; line-height: 1.55; font-weight: 720; }
    .verification-panel { display: grid; gap: 16px; }
    .verification-panel h2 { margin: 0; color: #fff; font-size: 24px; line-height: 1.15; }
    .verification-panel p { margin: 0; color: #a8b3c7; line-height: 1.5; font-size: 13px; font-weight: 700; }
    .verification-email { color: #fff; font-weight: 900; overflow-wrap: anywhere; }
    .verification-actions { display: grid; gap: 10px; }
    .success { display: none; text-align: center; padding: 10px 0 4px; }
    .success.active { display: block; }
    .success-mark { width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 999px; display: grid; place-items: center; background: linear-gradient(135deg, #8b5cf6, #2f7df6); font-weight: 950; font-size: 24px; box-shadow: 0 16px 34px rgba(47,125,246,.2); }
    .success h2 { margin: 0 0 8px; font-size: 26px; line-height: 1.1; }
    .success p { margin: 0 0 18px; color: #a8b3c7; line-height: 1.5; }
    .key-card { margin: 0 0 16px; padding: 16px; border-radius: 15px; border: 1px solid rgba(139,92,246,.34); background: rgba(2,6,23,.55); }
    .key-card code { display: block; color: #fff; font-size: 18px; font-weight: 900; letter-spacing: .04em; overflow-wrap: anywhere; }
    .pin-card { margin: 0 0 16px; padding: 14px; border-radius: 15px; border: 1px solid rgba(251,191,36,.34); background: rgba(251,191,36,.08); }
    .pin-card p { margin: 0 0 10px; color: #fde68a; font-size: 12px; line-height: 1.45; font-weight: 850; }
    .pin-card code { display: block; color: #fff; font-size: 18px; font-weight: 950; letter-spacing: .08em; }
    .success-actions { display: grid; gap: 10px; }
    .payment-status-result { display: grid; gap: 14px; text-align: center; padding: 8px 0 4px; }
    .payment-status-mark { width: 54px; height: 54px; margin: 0 auto; border-radius: 999px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #8b5cf6, #2f7df6); font-weight: 950; font-size: 22px; box-shadow: 0 16px 34px rgba(47,125,246,.2); }
    .payment-status-result.is-processing .payment-status-mark { background: linear-gradient(135deg, #f59e0b, #8b5cf6); }
    .payment-status-result.is-missing .payment-status-mark { background: linear-gradient(135deg, #64748b, #334155); }
    .payment-status-result h2 { margin: 0; color: #fff; font-size: 25px; line-height: 1.12; letter-spacing: 0; }
    .payment-status-result p { margin: 0; color: #a8b3c7; line-height: 1.5; font-size: 13px; font-weight: 700; }
    .payment-status-actions { display: grid; gap: 10px; }
    .site-footer { display: flex; align-items: center; justify-content: center; gap: 10px; }
    .social-link { width: 42px; height: 42px; display: grid; place-items: center; color: #a8b3c7; border: 1px solid rgba(148,163,184,.16); border-radius: 12px; background: rgba(15,23,42,.62); text-decoration: none; transition: color .16s ease, border-color .16s ease, background .16s ease, transform .16s ease; }
    .social-link:hover { color: #fff; border-color: rgba(139,92,246,.58); background: rgba(139,92,246,.18); transform: translateY(-2px); }
    .social-link:focus-visible { outline: 3px solid rgba(139,92,246,.34); outline-offset: 3px; }
    .social-link svg { width: 20px; height: 20px; fill: currentColor; }
    [hidden] { display: none !important; }
    @media (max-width: 920px) {
      main { align-items: start; padding: 22px 0; }
      .hero { grid-template-columns: 1fr; }
      .intro { min-height: auto; padding: 28px; }
      .card { padding: 24px; }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 20px, 1120px); }
      .intro, .card { padding: 20px; border-radius: 16px; }
      .intro-top { align-items: flex-start; flex-direction: column; }
      .intro h1 { font-size: 42px; }
      .hero-art, .signup-closed .hero-art { height: 190px; border-radius: 14px; }
      .actions, .benefits { grid-template-columns: 1fr; }
      .plan-options { grid-template-columns: 1fr; }
      .button { width: 100%; }
      .benefits { display: grid; }
      .segment button { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="hero">
      <section class="panel intro">
        <div>
          <div class="intro-top">
            <div class="brand"><span class="logo">M</span><span>Merlin Launcher</span></div>
            <select class="language-select" id="languageSelect" aria-label="Language">
              <option value="en">English</option>
              <option value="ptbr">Português</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
          <h1>Merlin</h1>
          <p data-i18n="heroDescription">Download the latest version of Merlin and manage your access key safely.</p>
          <img class="hero-art" src="/merlin-download-hero.png" alt="Merlin" />
          <div class="actions">
            <a class="button primary download" href="/api/updates/download"><span>⬇</span> <span data-i18n="download">Download Merlin</span></a>
          </div>
          <div class="version" id="versionText" data-i18n="versionLoading">Loading current version...</div>
          <div class="benefits" aria-label="Beneficios do Merlin">
            <div class="benefit"><span>🎮</span><span data-i18n="benefitLibrary">Exclusive library</span></div>
            <div class="benefit"><span>⚡</span><span data-i18n="benefitAllInOne">Everything in one place</span></div>
            <div class="benefit signup-copy"><span>🔍</span><span data-i18n="benefitOpenCode">Open source</span></div>
            <div class="benefit signup-copy"><span>🚀</span><span data-i18n="benefitEvolution">Always evolving</span></div>
          </div>
          <section class="faq" aria-labelledby="faqTitle">
            <h2 id="faqTitle" data-i18n="faqTitle">Frequently asked questions</h2>
            <div class="faq-list">
              <div class="faq-item is-open">
                <button class="faq-question" type="button" aria-expanded="true">
                  <span data-i18n="faqWhatTitle">🧙‍♂️ What is Merlin?</span>
                  <span aria-hidden="true">+</span>
                </button>
                <div class="faq-answer">
                  <p data-i18n="faqWhatBody">Merlin is a PC platform created to make downloading games much simpler. Forget complicated processes: just choose the game, download, and play.</p>
                </div>
              </div>
              <div class="faq-item">
                <button class="faq-question" type="button" aria-expanded="false">
                  <span data-i18n="faqSafeTitle">🛡️ Is Merlin safe?</span>
                  <span aria-hidden="true">+</span>
                </button>
                <div class="faq-answer">
                  <p data-i18n="faqSafeBody">Yes. Merlin does not ask for your Steam password and is a 100% open source project, allowing anyone to review how it works.</p>
                </div>
              </div>
              <div class="faq-item">
                <button class="faq-question" type="button" aria-expanded="false">
                  <span data-i18n="faqBanTitle">🎮 Can I get banned using Merlin?</span>
                  <span aria-hidden="true">+</span>
                </button>
                <div class="faq-answer">
                  <p data-i18n="faqBanBody">To this day, there are no known reports of bans from using this technology, which has been used by the community for years. As a preventive measure, we recommend using Merlin on a secondary Steam account during setup.</p>
                </div>
              </div>
              <div class="faq-item">
                <button class="faq-question" type="button" aria-expanded="false">
                  <span data-i18n="faqFreeTitle">🎁 Why is Merlin free?</span>
                  <span aria-hidden="true">+</span>
                </button>
                <div class="faq-answer">
                  <p data-i18n="faqFreeBody">Merlin is still experimental. During this period, access is free so the community can test the platform, send feedback, and help develop the project.</p>
                </div>
              </div>
              <div class="faq-item">
                <button class="faq-question" type="button" aria-expanded="false">
                  <span data-i18n="faqDifferentTitle">⭐ What makes Merlin different?</span>
                  <span aria-hidden="true">+</span>
                </button>
                <div class="faq-answer">
                  <p data-i18n="faqDifferentBody">Besides simplifying the whole process, Merlin also provides games that are part of the library officially acquired by the team. Many of these titles would normally require buying an official license at full price or relying on unreliable methods found online. Merlin's goal is to offer a much simpler, organized, and transparent experience for the community.</p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section class="panel card" id="signupCard" hidden>
        <form class="form-panel" id="registerForm" novalidate>
          <div class="plan-selector" id="planSelector" hidden>
            <p class="plan-selector__title" data-i18n="choosePlan">Choose your plan</p>
            <div class="plan-options" id="planOptions">
              <label class="plan-option" data-plan-option="monthly">
                <input type="radio" name="planType" value="monthly" />
                <strong data-i18n="monthlyPlan">Monthly</strong>
                <span data-plan-price="monthly">--</span>
                <small data-i18n="monthlyPlanHint">Renewed automatically.</small>
              </label>
              <label class="plan-option" data-plan-option="lifetime">
                <input type="radio" name="planType" value="lifetime" />
                <strong data-i18n="lifetimePlan">Lifetime</strong>
                <span data-plan-price="lifetime">--</span>
                <small data-i18n="lifetimePlanHint">One-time payment.</small>
              </label>
            </div>
            <div class="field-error" data-plan-error></div>
          </div>
          <div class="field" data-field="name">
            <span data-i18n="name">Name</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">♙</span>
              <input name="name" autocomplete="name" required />
            </div>
            <div class="field-error"></div>
          </div>
          <div class="field" data-field="contact">
            <span data-i18n="emailContact">E-mail</span>
            <div class="input-wrap">
              <span class="input-icon" data-contact-icon aria-hidden="true">@</span>
              <input name="contact" type="email" autocomplete="email" inputmode="email" required />
            </div>
            <div class="field-error"></div>
          </div>
          <input name="contactType" type="hidden" value="email" />
          <div class="field" data-field="recoveryPin">
            <span data-i18n="pin">Recovery PIN</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">#</span>
              <input name="recoveryPin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required />
            </div>
            <div class="field-error"></div>
          </div>
          <p class="hint" data-i18n="contactHint">Your contact will only be used to help recover your key if you lose it.</p>
          <p class="hint" data-i18n="pinHint">Keep this PIN. It will be required to recover your access key.</p>
          <label class="notice">
            <input name="acceptedRecoveryNotice" type="checkbox" required />
            <span data-i18n="notice">I understand that if I lose my contact or PIN, it may not be possible to recover my key.</span>
          </label>
          <div class="field-error" data-checkbox-error></div>
          <button class="button primary" type="submit" data-default-key="createSubmit" data-default-text="Create my access key">Create my access key</button>
          <div class="support-links">
            <button class="text-link" id="recoverLink" type="button" data-i18n="recoverInline">Already have a key? Recover access</button>
            <button class="text-link" id="paymentStatusLink" type="button" data-i18n="paymentStatusInline">Already paid? Check payment status</button>
            <button class="text-link" id="billingPortalLink" type="button" data-i18n="billingPortalInline">Manage monthly subscription</button>
          </div>
        </form>

        <form class="verification-panel" id="emailVerificationForm" hidden novalidate>
          <div>
            <h2 data-i18n="emailVerificationTitle">Confirm your e-mail</h2>
            <p>
              <span data-i18n="emailVerificationSentTo">We sent a 6-digit code to</span>
              <span class="verification-email" id="verificationEmail"></span>.
            </p>
          </div>
          <div class="field" data-field="emailCode">
            <span data-i18n="emailCode">Verification code</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">#</span>
              <input name="emailCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required />
            </div>
            <div class="field-error"></div>
          </div>
          <div class="verification-actions">
            <button class="button primary" type="submit" data-default-key="confirmEmailCode" data-default-text="Confirm code">Confirm code</button>
            <button class="button ghost" id="resendEmailCode" type="button" data-default-key="resendEmailCode" data-default-text="Resend code">Resend code</button>
            <button class="button subtle" id="changeEmail" type="button" data-i18n="changeEmail">Use another e-mail</button>
          </div>
        </form>

        <form class="form-panel" id="recoverForm" hidden novalidate>
          <h2 class="form-title" data-i18n="recoverTitle">Recover access</h2>
          <div class="field" data-field="contact">
            <span data-i18n="emailContact">E-mail</span>
            <div class="input-wrap">
              <span class="input-icon" data-contact-icon aria-hidden="true">@</span>
              <input name="contact" type="email" autocomplete="email" inputmode="email" required />
            </div>
            <div class="field-error"></div>
          </div>
          <input name="contactType" type="hidden" value="email" />
          <div class="field" data-field="recoveryPin">
            <span data-i18n="pin">Recovery PIN</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">#</span>
              <input name="recoveryPin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required />
            </div>
            <div class="field-error"></div>
          </div>
          <button class="button primary" type="submit" data-default-key="recoverSubmit" data-default-text="Recover my access key">Recover my access key</button>
          <button class="button subtle" data-back-to-register type="button" data-i18n="backToCreate">Back to sign up</button>
        </form>

        <form class="form-panel" id="paymentStatusForm" hidden novalidate>
          <h2 class="form-title" data-i18n="paymentStatusTitle">Check payment</h2>
          <div class="field" data-field="contact">
            <span data-i18n="emailContact">E-mail</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">@</span>
              <input name="contact" type="email" autocomplete="email" inputmode="email" required />
            </div>
            <div class="field-error"></div>
          </div>
          <input name="contactType" type="hidden" value="email" />
          <p class="hint" data-i18n="paymentStatusHint">Use the same e-mail used at checkout. We will send a code before showing your payment status.</p>
          <button class="button primary" type="submit" data-default-key="paymentStatusSubmit" data-default-text="Check payment">Check payment</button>
          <button class="button subtle" data-back-to-register type="button" data-i18n="backToCreate">Back to sign up</button>
        </form>

        <form class="form-panel" id="billingPortalForm" hidden novalidate>
          <h2 class="form-title" data-i18n="billingPortalTitle">Manage monthly subscription</h2>
          <div class="field" data-field="contact">
            <span data-i18n="emailContact">E-mail</span>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">@</span>
              <input name="contact" type="email" autocomplete="email" inputmode="email" required />
            </div>
            <div class="field-error"></div>
          </div>
          <input name="contactType" type="hidden" value="email" />
          <p class="hint" data-i18n="billingPortalHint">Use the e-mail linked to your monthly Stripe subscription. Lifetime purchases do not have a subscription portal.</p>
          <button class="button primary" type="submit" data-default-key="billingPortalSubmit" data-default-text="Open portal">Open portal</button>
          <button class="button subtle" data-back-to-register type="button" data-i18n="backToCreate">Back to sign up</button>
        </form>

        <div class="payment-status-result" id="paymentStatusResult" hidden>
          <div class="payment-status-mark" id="paymentStatusMark">...</div>
          <div>
            <h2 id="paymentStatusResultTitle">Payment status</h2>
            <p id="paymentStatusResultText">Checking your payment status.</p>
          </div>
          <div class="key-card" id="paymentStatusKeyCard" hidden>
            <code id="paymentStatusLicenseKey"></code>
          </div>
          <div class="payment-status-actions">
            <button class="button ghost" id="copyPaymentStatusKey" type="button" data-i18n="copyKey" hidden>Copy key</button>
            <a class="button primary" id="paymentStatusDownload" href="/api/updates/download" data-i18n="download" hidden>Download Merlin</a>
            <button class="button primary" id="retryPaymentStatus" type="button" data-default-key="paymentStatusRetry" data-default-text="Check again">Check again</button>
            <button class="button subtle" data-back-to-register type="button" data-i18n="backToCreate">Back to sign up</button>
          </div>
        </div>

        <div class="message" id="message"></div>
        <div class="status-modal" id="statusModal" role="dialog" aria-modal="true" aria-labelledby="statusModalTitle" hidden>
          <div class="status-modal__backdrop" data-close-status-modal></div>
          <div class="status-modal__panel">
            <div class="status-modal__mark" id="statusModalMark">i</div>
            <div>
              <h2 id="statusModalTitle">Status</h2>
              <p id="statusModalText">Message</p>
            </div>
            <button class="button primary" id="statusModalClose" type="button" data-i18n="modalClose">OK</button>
          </div>
        </div>
        <div class="success" id="result">
          <div class="success-mark">✓</div>
          <h2 id="resultTitle">Your key was created</h2>
          <p data-i18n="successDescription">Keep your key somewhere safe. It will be used to access Merlin.</p>
          <div class="key-card">
            <code id="licenseKey"></code>
          </div>
          <div class="pin-card" id="pinCard" hidden>
            <p data-i18n="pinFinalNotice">Save your recovery PIN now. It will not be sent by e-mail.</p>
            <code id="recoveryPinValue"></code>
          </div>
          <div class="success-actions">
            <button class="button ghost" id="copyKey" type="button" data-i18n="copyKey">Copy key</button>
            <a class="button primary" href="/api/updates/download" data-i18n="download">Download Merlin</a>
            <button class="button subtle" id="backToStart" type="button" data-i18n="backToStart">Back to start</button>
          </div>
        </div>
      </section>
    </div>
    <footer class="site-footer" aria-label="Redes sociais do Merlin">
      <a class="social-link" href="https://www.instagram.com/merlin.launcher/" target="_blank" rel="noopener noreferrer" aria-label="Merlin no Instagram" title="Instagram">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.8 2h8.4A5.8 5.8 0 0 1 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8A5.8 5.8 0 0 1 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2Zm-.2 2A3.6 3.6 0 0 0 4 7.6v8.8A3.6 3.6 0 0 0 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6A3.6 3.6 0 0 0 16.4 4H7.6Zm9.65 1.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>
      </a>
      <a class="social-link" href="https://www.tiktok.com/@merlin.launcher" target="_blank" rel="noopener noreferrer" aria-label="Merlin no TikTok" title="TikTok">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.8 2c.35 2.05 1.5 3.48 3.7 3.62v3.16a7.4 7.4 0 0 1-3.66-.99v6.37a6.16 6.16 0 1 1-5.32-6.1c.42-.05.84-.06 1.25-.02v3.23a3 3 0 1 0 .02 5.74c.7-.23 1.14-.68 1.33-1.34.08-.25.12-.58.12-.98V2h2.56Z"/></svg>
      </a>
      <a class="social-link" href="https://github.com/azteka-merlin/Merlin-luncher/" target="_blank" rel="noopener noreferrer" aria-label="Código do Merlin no GitHub" title="GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.82a9.5 9.5 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
      </a>
    </footer>
  </main>
  <script src="/download.js?v=20260805-recover-copy-1" defer></script>
</body>
</html>`;
}

function renderPublicDownloadScript() {
  return `"use strict";

const messages = {
  en: {
    heroDescription: "Download the latest version of Merlin and manage your access key safely.",
    heroDescriptionDownloadOnly: "Download the latest version of Merlin.",
    download: "Download Merlin",
    versionLoading: "Loading current version...",
    versionCurrent: "Current version: {version}",
    versionAvailable: "Current version available for download.",
    downloadAvailable: "Download available.",
    benefitInstall: "Simple installation",
    benefitUpdates: "Automatic updates",
    benefitRecovery: "Access key recovery",
    benefitActivation: "Secure activation",
    benefitLibrary: "Exclusive library",
    benefitAllInOne: "Everything in one place",
    benefitOpenCode: "Open source",
    benefitEvolution: "Always evolving",
    faqTitle: "Frequently asked questions",
    faqWhatTitle: "🧙‍♂️ What is Merlin?",
    faqWhatBody: "Merlin is a PC platform created to make downloading games much simpler. Forget complicated processes: just choose the game, download, and play.",
    faqSafeTitle: "🛡️ Is Merlin safe?",
    faqSafeBody: "Yes. Merlin does not ask for your Steam password and is a 100% open source project, allowing anyone to review how it works.",
    faqBanTitle: "🎮 Can I get banned using Merlin?",
    faqBanBody: "To this day, there are no known reports of bans from using this technology, which has been used by the community for years. As a preventive measure, we recommend using Merlin on a secondary Steam account during setup.",
    faqFreeTitle: "🎁 Why is Merlin free?",
    faqFreeBody: "Merlin is still experimental. During this period, access is free so the community can test the platform, send feedback, and help develop the project.",
    faqPaidTitle: "💳 Why is Merlin paid?",
    faqPaidBody: "The amount collected helps cover platform operating costs and, above all, keeps exclusive games coming to Merlin. Some titles would otherwise require a full-price store purchase or risky unofficial methods that can expose your computer.",
    faqDifferentTitle: "⭐ What makes Merlin different?",
    faqDifferentBody: "Besides simplifying the whole process, Merlin also provides games that are part of the library officially acquired by the team. Many of these titles would normally require buying an official license at full price or relying on unreliable methods found online. Merlin's goal is to offer a much simpler, organized, and transparent experience for the community.",
    createTab: "Create key",
    recoverTab: "Recover",
    paymentStatusTab: "Payment",
    modalClose: "Got it",
    recoverTitle: "Recover access",
    recoverInline: "Already have a key? Recover access",
    paymentStatusTitle: "Check payment",
    paymentStatusInline: "Already paid? Check payment status",
    paymentStatusSubmit: "Check payment",
    paymentStatusRetry: "Check again",
    paymentStatusHint: "Use the same e-mail used at checkout. We will send a code before showing your payment status.",
    billingPortalInline: "Manage monthly subscription",
    billingPortalTitle: "Manage monthly subscription",
    billingPortalHint: "Use the e-mail linked to your monthly Stripe subscription. Lifetime purchases do not have a subscription portal.",
    billingPortalSubmit: "Open portal",
    billingPortalLoading: "Opening portal...",
    billingPortalRedirecting: "Redirecting to the secure Stripe portal...",
    billingPortalUnavailable: "We could not open a monthly subscription portal for this e-mail.",
    backToCreate: "Back to sign up",
    choosePlan: "Choose your plan",
    monthlyPlan: "Monthly",
    monthlyPlanHint: "Renewed automatically.",
    monthlyPriceSuffix: "/ month",
    lifetimePlan: "Lifetime",
    lifetimePlanHint: "One-time payment.",
    checkoutSubmit: "Continue to payment",
    checkoutLoading: "Opening secure checkout...",
    checkoutRedirecting: "Redirecting to Stripe...",
    checkoutReceivedTitle: "Payment received",
    checkoutSuccessPending: "Payment confirmed by Stripe. Your access will be released after processing.",
    checkoutCanceledTitle: "Payment canceled",
    checkoutCanceled: "Payment was canceled. You can choose a plan and try again.",
    checkoutStillProcessingTitle: "Access processing",
    checkoutStillProcessing: "Payment received. Your key is still being processed. Check the payment status using the same e-mail in a moment.",
    paymentStatusLoading: "Checking payment...",
    paymentStatusProcessing: "Payment found. Your access is still being processed. Try again in a moment.",
    paymentStatusNotFound: "No payment or active key was found for this e-mail yet. If you just paid, wait a moment and try again.",
    paymentApprovedTitle: "Payment approved",
    paymentApprovedText: "Your access is already available.",
    paymentProcessingTitle: "Payment processing",
    paymentProcessingText: "We found your purchase, but access is still being released. Try checking again in a moment.",
    paymentExpiredTitle: "Checkout expired",
    paymentExpiredText: "This payment link expired before payment was completed. Go back to sign up and generate a new checkout.",
    paymentExistingTitle: "Key found",
    paymentExistingText: "We found an active key for this e-mail.",
    paymentMissingTitle: "Nothing found",
    paymentMissingText: "We did not find a payment or active key for this e-mail. If you just paid, wait a moment and check again.",
    errorPlan: "Choose a plan to continue.",
    name: "Name",
    contact: "Contact",
    emailContact: "E-mail",
    contactType: "Contact type",
    phone: "Phone",
    email: "E-mail",
    pin: "Recovery PIN",
    contactHint: "We use this e-mail only for your key, recovery, and important notices.",
    pinHint: "Keep this PIN. It will be required to recover your access key.",
    notice: "I understand that if I lose my contact or PIN, it may not be possible to recover my key.",
    createSubmit: "Create my access key",
    recoverSubmit: "Recover my access key",
    successCreated: "Your key was created",
    successRecovered: "Your key was recovered",
    successExisting: "Your access key",
    successDescription: "Keep your key somewhere safe. It will be used to access Merlin.",
    pinFinalNotice: "Save your recovery PIN now. It will not be sent by e-mail.",
    copyKey: "Copy key",
    copied: "Key copied",
    backToStart: "Back to start",
    loading: "Please wait...",
    errorName: "Enter your name.",
    errorContact: "Enter your contact.",
    errorEmail: "Enter a valid e-mail.",
    emailCode: "Verification code",
    emailVerificationTitle: "Confirm your e-mail",
    emailVerificationSentTo: "We sent a 6-digit code to",
    confirmEmailCode: "Confirm code",
    resendEmailCode: "Resend code",
    sendingCode: "Sending code...",
    emailCodeSent: "Code sent. Check your e-mail and, if necessary, review your spam folder.",
    emailVerified: "E-mail verified. Creating your access key...",
    changeEmail: "Use another e-mail",
    errorEmailCode: "Enter the 6-digit code sent to your e-mail.",
    emailVerificationRequired: "For security, confirm your e-mail again.",
    errorPin: "Use a PIN with 4 to 8 numbers.",
    errorNotice: "Confirm the recovery notice to continue.",
    accessKeyUnavailable: "Could not create a new key with this information. If you already have a key, use the recovery option.",
    recoveryUnavailable: "Could not recover a key with this information. Check your details and try again.",
    genericError: "Could not complete the request.",
  },
  ptbr: {
    heroDescription: "Baixe a versão mais recente do Merlin e gerencie sua chave de acesso com segurança.",
    heroDescriptionDownloadOnly: "Baixe a versão mais recente do Merlin.",
    download: "Baixar Merlin",
    versionLoading: "Carregando versão atual...",
    versionCurrent: "Versão atual: {version}",
    versionAvailable: "Versão atual disponível para download.",
    downloadAvailable: "Download disponível.",
    benefitInstall: "Instalação simples",
    benefitUpdates: "Atualizações automáticas",
    benefitRecovery: "Recuperação de chave",
    benefitActivation: "Ativação segura",
    benefitLibrary: "Biblioteca exclusiva",
    benefitAllInOne: "Tudo em um só lugar",
    benefitOpenCode: "Código aberto",
    benefitEvolution: "Em constante evolução",
    faqTitle: "Perguntas frequentes",
    faqWhatTitle: "🧙‍♂️ O que é o Merlin?",
    faqWhatBody: "O Merlin é uma plataforma para PC criada para tornar o download de jogos muito mais simples. Esqueça processos complicados: basta escolher o jogo, baixar e jogar.",
    faqSafeTitle: "🛡️ O Merlin é seguro?",
    faqSafeBody: "Sim. O Merlin não solicita sua senha da Steam e é um projeto 100% de código aberto, permitindo que qualquer pessoa analise seu funcionamento.",
    faqBanTitle: "🎮 Posso levar ban usando o Merlin?",
    faqBanBody: "Até hoje, não existem relatos conhecidos de banimento pelo uso dessa tecnologia, utilizada pela comunidade há anos. Como medida preventiva, recomendamos utilizar o Merlin em uma conta Steam secundária durante a configuração.",
    faqFreeTitle: "🎁 Por que o Merlin está gratuito?",
    faqFreeBody: "O Merlin ainda está em fase experimental. Durante esse período, o acesso é gratuito para que a comunidade possa testar a plataforma, enviar feedbacks e ajudar no desenvolvimento do projeto.",
    faqPaidTitle: "💳 Por que a plataforma é paga?",
    faqPaidBody: "O valor arrecadado é direcionado aos custos operacionais da plataforma e, principalmente, para garantir que jogos exclusivos continuem sendo adicionados ao Merlin. Hoje existem títulos que normalmente exigem compra pelo preço cheio nas lojas ou simplesmente ficam fora do alcance. Alguns até podem existir por meios não oficiais, mas o processo costuma ser difícil e expõe demais o computador do usuário.",
    faqDifferentTitle: "⭐ O que torna o Merlin diferente?",
    faqDifferentBody: "Além de simplificar todo o processo, o Merlin também disponibiliza jogos que fazem parte da biblioteca adquirida oficialmente pela equipe. Muitos desses títulos normalmente só podem ser acessados comprando uma licença oficial pelo preço cheio ou recorrendo a métodos pouco confiáveis encontrados na internet. O objetivo do Merlin é oferecer uma experiência muito mais simples, organizada e transparente para a comunidade.",
    createTab: "Criar chave",
    recoverTab: "Recuperar",
    paymentStatusTab: "Pagamento",
    modalClose: "Entendi",
    recoverTitle: "Recuperar acesso",
    recoverInline: "Já tem uma chave? Recuperar acesso",
    paymentStatusTitle: "Consultar pagamento",
    paymentStatusInline: "Já realizou o pagamento? Consulte o status aqui",
    paymentStatusSubmit: "Consultar pagamento",
    paymentStatusRetry: "Consultar novamente",
    paymentStatusHint: "Use o mesmo e-mail usado no checkout. Vamos enviar um código antes de mostrar o status da compra.",
    billingPortalInline: "Gerenciar mensalidade",
    billingPortalTitle: "Gerenciar mensalidade",
    billingPortalHint: "Use o e-mail vinculado à assinatura mensal na Stripe. Compras vitalícias não possuem portal de assinatura.",
    billingPortalSubmit: "Abrir portal",
    billingPortalLoading: "Abrindo portal...",
    billingPortalRedirecting: "Redirecionando para o portal seguro da Stripe...",
    billingPortalUnavailable: "Não foi possível abrir um portal de mensalidade para este e-mail.",
    backToCreate: "Voltar ao cadastro",
    choosePlan: "Escolha seu plano",
    monthlyPlan: "Mensal",
    monthlyPlanHint: "Renovação automática.",
    monthlyPriceSuffix: "/ mês",
    lifetimePlan: "Vitalício",
    lifetimePlanHint: "Pagamento único.",
    checkoutSubmit: "Continuar para pagamento",
    checkoutLoading: "Abrindo checkout seguro...",
    checkoutRedirecting: "Redirecionando para a Stripe...",
    checkoutReceivedTitle: "Pagamento recebido",
    checkoutSuccessPending: "Pagamento confirmado pela Stripe. Seu acesso será liberado após o processamento.",
    checkoutCanceledTitle: "Pagamento cancelado",
    checkoutCanceled: "Pagamento cancelado. Escolha um plano e tente novamente.",
    checkoutStillProcessingTitle: "Acesso em processamento",
    checkoutStillProcessing: "Pagamento recebido. Sua chave ainda está sendo processada. Consulte o pagamento usando o mesmo e-mail em alguns instantes.",
    paymentStatusLoading: "Consultando pagamento...",
    paymentStatusProcessing: "Pagamento encontrado. Seu acesso ainda está sendo processado. Tente novamente em alguns instantes.",
    paymentStatusNotFound: "Nenhum pagamento ou chave ativa foi encontrado para este e-mail ainda. Se você acabou de pagar, aguarde alguns instantes e tente novamente.",
    paymentApprovedTitle: "Pagamento aprovado",
    paymentApprovedText: "Seu acesso já está liberado.",
    paymentProcessingTitle: "Pagamento em processamento",
    paymentProcessingText: "Encontramos sua compra, mas a liberação do acesso ainda está sendo concluída. Consulte novamente em alguns instantes.",
    paymentExpiredTitle: "Checkout expirado",
    paymentExpiredText: "Este link de pagamento expirou antes da conclusão. Volte ao cadastro e gere um novo checkout.",
    paymentExistingTitle: "Chave encontrada",
    paymentExistingText: "Encontramos uma chave ativa para este e-mail.",
    paymentMissingTitle: "Nada encontrado",
    paymentMissingText: "Não encontramos pagamento ou chave ativa para este e-mail. Se você acabou de pagar, aguarde alguns instantes e consulte novamente.",
    errorPlan: "Escolha um plano para continuar.",
    name: "Nome",
    contact: "Contato",
    emailContact: "E-mail",
    contactType: "Tipo de contato",
    phone: "Telefone",
    email: "E-mail",
    pin: "PIN de recuperação",
    contactHint: "Usamos este e-mail apenas para sua chave, recuperação e avisos importantes.",
    pinHint: "Guarde esse PIN. Ele será necessário para recuperar sua chave de acesso.",
    notice: "Entendo que, se eu perder meu contato ou PIN, talvez não seja possível recuperar minha chave.",
    createSubmit: "Criar minha chave de acesso",
    recoverSubmit: "Recuperar minha chave de acesso",
    successCreated: "Sua chave foi criada",
    successRecovered: "Sua chave foi recuperada",
    successExisting: "Sua chave de acesso",
    successDescription: "Guarde sua chave em um lugar seguro. Ela será usada para acessar o Merlin.",
    pinFinalNotice: "Guarde seu PIN de recuperação agora. Ele não será enviado por e-mail.",
    copyKey: "Copiar chave",
    copied: "Chave copiada",
    backToStart: "Voltar ao início",
    loading: "Aguarde...",
    errorName: "Informe seu nome.",
    errorContact: "Informe seu contato.",
    errorEmail: "Informe um e-mail válido.",
    emailCode: "Código de verificação",
    emailVerificationTitle: "Confirme seu e-mail",
    emailVerificationSentTo: "Enviamos um código de 6 dígitos para",
    confirmEmailCode: "Confirmar código",
    resendEmailCode: "Reenviar código",
    sendingCode: "Enviando código...",
    emailCodeSent: "Código enviado. Confira seu e-mail e, se necessário, verifique a caixa de spam.",
    emailVerified: "E-mail verificado. Criando sua chave de acesso...",
    changeEmail: "Usar outro e-mail",
    errorEmailCode: "Informe o código de 6 dígitos enviado para seu e-mail.",
    emailVerificationRequired: "Por segurança, confirme seu e-mail novamente.",
    errorPin: "Use um PIN com 4 a 8 números.",
    errorNotice: "Confirme o aviso de recuperação para continuar.",
    accessKeyUnavailable: "Não foi possível criar uma nova chave com esses dados. Se você já possui uma chave, use a opção Recuperar.",
    recoveryUnavailable: "Não foi possível recuperar uma chave com esses dados. Confira as informações e tente novamente.",
    genericError: "Não foi possível concluir a solicitação.",
  },
  es: {
    heroDescription: "Descarga la versión más reciente de Merlin y administra tu clave de acceso de forma segura.",
    heroDescriptionDownloadOnly: "Descarga la versión más reciente de Merlin.",
    download: "Descargar Merlin",
    versionLoading: "Cargando versión actual...",
    versionCurrent: "Versión actual: {version}",
    versionAvailable: "Versión actual disponible para descargar.",
    downloadAvailable: "Descarga disponible.",
    benefitInstall: "Instalación simple",
    benefitUpdates: "Actualizaciones automáticas",
    benefitRecovery: "Recuperación de clave",
    benefitActivation: "Activación segura",
    benefitLibrary: "Biblioteca exclusiva",
    benefitAllInOne: "Todo en un solo lugar",
    benefitOpenCode: "Código abierto",
    benefitEvolution: "En constante evolución",
    faqTitle: "Preguntas frecuentes",
    faqWhatTitle: "🧙‍♂️ ¿Qué es Merlin?",
    faqWhatBody: "Merlin es una plataforma para PC creada para hacer mucho más simple la descarga de juegos. Olvídate de procesos complicados: solo elige el juego, descarga y juega.",
    faqSafeTitle: "🛡️ ¿Merlin es seguro?",
    faqSafeBody: "Sí. Merlin no solicita tu contraseña de Steam y es un proyecto 100% de código abierto, lo que permite que cualquiera revise cómo funciona.",
    faqBanTitle: "🎮 ¿Puedo recibir un ban usando Merlin?",
    faqBanBody: "Hasta hoy, no existen reportes conocidos de baneos por el uso de esta tecnología, utilizada por la comunidad desde hace años. Como medida preventiva, recomendamos utilizar Merlin en una cuenta secundaria de Steam durante la configuración.",
    faqFreeTitle: "🎁 ¿Por qué Merlin es gratis?",
    faqFreeBody: "Merlin todavía está en fase experimental. Durante este período, el acceso es gratuito para que la comunidad pueda probar la plataforma, enviar comentarios y ayudar en el desarrollo del proyecto.",
    faqPaidTitle: "💳 ¿Por qué la plataforma es de pago?",
    faqPaidBody: "El valor recaudado ayuda a cubrir los costos operativos de la plataforma y, sobre todo, a garantizar que se sigan agregando juegos exclusivos a Merlin. Algunos títulos exigirían comprarlos a precio completo o recurrir a métodos no oficiales y poco seguros.",
    faqDifferentTitle: "⭐ ¿Qué hace diferente a Merlin?",
    faqDifferentBody: "Además de simplificar todo el proceso, Merlin también ofrece juegos que forman parte de la biblioteca adquirida oficialmente por el equipo. Muchos de estos títulos normalmente solo pueden accederse comprando una licencia oficial a precio completo o recurriendo a métodos poco confiables encontrados en internet. El objetivo de Merlin es ofrecer una experiencia mucho más simple, organizada y transparente para la comunidad.",
    createTab: "Crear clave",
    recoverTab: "Recuperar",
    name: "Nombre",
    contact: "Contacto",
    emailContact: "E-mail",
    contactType: "Tipo de contacto",
    phone: "Teléfono",
    email: "E-mail",
    pin: "PIN de recuperación",
    contactHint: "Usamos este e-mail solo para tu clave, recuperación y avisos importantes.",
    pinHint: "Guarda este PIN. Será necesario para recuperar tu clave de acceso.",
    notice: "Entiendo que, si pierdo mi contacto o PIN, quizá no sea posible recuperar mi clave.",
    createSubmit: "Crear mi clave de acceso",
    recoverSubmit: "Recuperar mi clave de acceso",
    successCreated: "Tu clave fue creada",
    successRecovered: "Tu clave fue recuperada",
    successExisting: "Tu clave de acceso",
    successDescription: "Guarda tu clave en un lugar seguro. Se usará para acceder a Merlin.",
    pinFinalNotice: "Guarda tu PIN de recuperación ahora. No se enviará por e-mail.",
    copyKey: "Copiar clave",
    copied: "Clave copiada",
    backToStart: "Volver al inicio",
    loading: "Espera...",
    errorName: "Ingresa tu nombre.",
    errorContact: "Ingresa tu contacto.",
    errorEmail: "Ingresa un e-mail válido.",
    emailCode: "Código de verificación",
    emailVerificationTitle: "Confirma tu e-mail",
    emailVerificationSentTo: "Enviamos un código de 6 dígitos a",
    confirmEmailCode: "Confirmar código",
    resendEmailCode: "Reenviar código",
    sendingCode: "Enviando código...",
    emailCodeSent: "Código enviado. Revisa tu e-mail y, si es necesario, verifica la carpeta de spam.",
    emailVerified: "E-mail verificado. Creando tu clave de acceso...",
    changeEmail: "Usar otro e-mail",
    errorEmailCode: "Ingresa el código de 6 dígitos enviado a tu e-mail.",
    errorPin: "Usa un PIN de 4 a 8 números.",
    errorNotice: "Confirma el aviso de recuperación para continuar.",
    accessKeyUnavailable: "No se pudo crear una nueva clave con estos datos. Si ya tienes una clave, usa la opción Recuperar.",
    recoveryUnavailable: "No se pudo recuperar una clave con estos datos. Revisa la información e inténtalo de nuevo.",
    genericError: "No se pudo completar la solicitud.",
  },
  fr: {
    heroDescription: "Téléchargez la dernière version de Merlin et gérez votre clé d'accès en toute sécurité.",
    heroDescriptionDownloadOnly: "Téléchargez la dernière version de Merlin.",
    download: "Télécharger Merlin",
    versionLoading: "Chargement de la version actuelle...",
    versionCurrent: "Version actuelle : {version}",
    versionAvailable: "Version actuelle disponible au téléchargement.",
    downloadAvailable: "Téléchargement disponible.",
    benefitInstall: "Installation simple",
    benefitUpdates: "Mises à jour automatiques",
    benefitRecovery: "Récupération de clé",
    benefitActivation: "Activation sécurisée",
    benefitLibrary: "Bibliothèque exclusive",
    benefitAllInOne: "Tout au même endroit",
    benefitOpenCode: "Code ouvert",
    benefitEvolution: "En constante évolution",
    faqTitle: "Questions fréquentes",
    faqWhatTitle: "🧙‍♂️ Qu'est-ce que Merlin ?",
    faqWhatBody: "Merlin est une plateforme PC créée pour rendre le téléchargement de jeux beaucoup plus simple. Oubliez les processus compliqués : choisissez le jeu, téléchargez et jouez.",
    faqSafeTitle: "🛡️ Merlin est-il sûr ?",
    faqSafeBody: "Oui. Merlin ne demande pas votre mot de passe Steam et c'est un projet 100% open source, ce qui permet à chacun d'analyser son fonctionnement.",
    faqBanTitle: "🎮 Puis-je être banni en utilisant Merlin ?",
    faqBanBody: "À ce jour, il n'existe aucun signalement connu de bannissement lié à l'utilisation de cette technologie, utilisée par la communauté depuis des années. Par mesure préventive, nous recommandons d'utiliser Merlin avec un compte Steam secondaire pendant la configuration.",
    faqFreeTitle: "🎁 Pourquoi Merlin est-il gratuit ?",
    faqFreeBody: "Merlin est encore en phase expérimentale. Pendant cette période, l'accès est gratuit afin que la communauté puisse tester la plateforme, envoyer des retours et aider au développement du projet.",
    faqPaidTitle: "💳 Pourquoi la plateforme est-elle payante ?",
    faqPaidBody: "Les montants collectés couvrent les coûts opérationnels de la plateforme et permettent surtout d'ajouter des jeux exclusifs à Merlin. Certains titres demanderaient autrement un achat au prix fort ou des méthodes non officielles risquées.",
    faqDifferentTitle: "⭐ Qu'est-ce qui rend Merlin différent ?",
    faqDifferentBody: "En plus de simplifier tout le processus, Merlin propose aussi des jeux faisant partie de la bibliothèque officiellement acquise par l'équipe. Beaucoup de ces titres ne sont normalement accessibles qu'en achetant une licence officielle au prix fort ou en utilisant des méthodes peu fiables trouvées sur internet. L'objectif de Merlin est d'offrir à la communauté une expérience beaucoup plus simple, organisée et transparente.",
    createTab: "Créer une clé",
    recoverTab: "Récupérer",
    name: "Nom",
    contact: "Contact",
    emailContact: "E-mail",
    contactType: "Type de contact",
    phone: "Téléphone",
    email: "E-mail",
    pin: "PIN de récupération",
    contactHint: "Nous utilisons cet e-mail uniquement pour votre clé, la récupération et les avis importants.",
    pinHint: "Conservez ce PIN. Il sera nécessaire pour récupérer votre clé d'accès.",
    notice: "Je comprends que si je perds mon contact ou mon PIN, il peut être impossible de récupérer ma clé.",
    createSubmit: "Créer ma clé d'accès",
    recoverSubmit: "Récupérer ma clé d'accès",
    successCreated: "Votre clé a été créée",
    successRecovered: "Votre clé a été récupérée",
    successExisting: "Votre clé d'accès",
    successDescription: "Conservez votre clé dans un endroit sûr. Elle servira à accéder à Merlin.",
    pinFinalNotice: "Conservez votre PIN de récupération maintenant. Il ne sera pas envoyé par e-mail.",
    copyKey: "Copier la clé",
    copied: "Clé copiée",
    backToStart: "Retour au début",
    loading: "Patientez...",
    errorName: "Indiquez votre nom.",
    errorContact: "Indiquez votre contact.",
    errorEmail: "Indiquez un e-mail valide.",
    emailCode: "Code de vérification",
    emailVerificationTitle: "Confirmez votre e-mail",
    emailVerificationSentTo: "Nous avons envoyé un code à 6 chiffres à",
    confirmEmailCode: "Confirmer le code",
    resendEmailCode: "Renvoyer le code",
    sendingCode: "Envoi du code...",
    emailCodeSent: "Code envoyé. Consultez votre e-mail et, si nécessaire, vérifiez le dossier spam.",
    emailVerified: "E-mail vérifié. Création de votre clé d'accès...",
    changeEmail: "Utiliser un autre e-mail",
    errorEmailCode: "Indiquez le code à 6 chiffres envoyé à votre e-mail.",
    errorPin: "Utilisez un PIN de 4 à 8 chiffres.",
    errorNotice: "Confirmez l'avis de récupération pour continuer.",
    accessKeyUnavailable: "Impossible de créer une nouvelle clé avec ces informations. Si vous avez déjà une clé, utilisez l'option de récupération.",
    recoveryUnavailable: "Impossible de récupérer une clé avec ces informations. Vérifiez les données et réessayez.",
    genericError: "Impossible de terminer la demande.",
  },
  de: {
    heroDescription: "Lade die neueste Version von Merlin herunter und verwalte deinen Zugangsschlüssel sicher.",
    heroDescriptionDownloadOnly: "Lade die neueste Version von Merlin herunter.",
    download: "Merlin herunterladen",
    versionLoading: "Aktuelle Version wird geladen...",
    versionCurrent: "Aktuelle Version: {version}",
    versionAvailable: "Aktuelle Version steht zum Download bereit.",
    downloadAvailable: "Download verfügbar.",
    benefitInstall: "Einfache Installation",
    benefitUpdates: "Automatische Updates",
    benefitRecovery: "Schlüsselwiederherstellung",
    benefitActivation: "Sichere Aktivierung",
    benefitLibrary: "Exklusive Bibliothek",
    benefitAllInOne: "Alles an einem Ort",
    benefitOpenCode: "Open Source",
    benefitEvolution: "Ständig in Entwicklung",
    faqTitle: "Häufige Fragen",
    faqWhatTitle: "🧙‍♂️ Was ist Merlin?",
    faqWhatBody: "Merlin ist eine PC-Plattform, die das Herunterladen von Spielen deutlich einfacher macht. Vergiss komplizierte Prozesse: Spiel auswählen, herunterladen und spielen.",
    faqSafeTitle: "🛡️ Ist Merlin sicher?",
    faqSafeBody: "Ja. Merlin fragt nicht nach deinem Steam-Passwort und ist ein 100% Open-Source-Projekt, sodass jeder nachvollziehen kann, wie es funktioniert.",
    faqBanTitle: "🎮 Kann ich durch Merlin gebannt werden?",
    faqBanBody: "Bis heute gibt es keine bekannten Berichte über Bans durch die Nutzung dieser Technologie, die seit Jahren von der Community verwendet wird. Als Vorsichtsmaßnahme empfehlen wir, Merlin während der Einrichtung mit einem sekundären Steam-Konto zu verwenden.",
    faqFreeTitle: "🎁 Warum ist Merlin kostenlos?",
    faqFreeBody: "Merlin befindet sich noch in einer experimentellen Phase. In dieser Zeit ist der Zugang kostenlos, damit die Community die Plattform testen, Feedback senden und bei der Entwicklung helfen kann.",
    faqPaidTitle: "💳 Warum ist die Plattform kostenpflichtig?",
    faqPaidBody: "Die Einnahmen decken Betriebskosten der Plattform und helfen vor allem dabei, weiterhin exklusive Spiele zu Merlin hinzuzufügen. Manche Titel wären sonst nur zum Vollpreis oder über riskante inoffizielle Methoden erreichbar.",
    faqDifferentTitle: "⭐ Was macht Merlin anders?",
    faqDifferentBody: "Neben der Vereinfachung des gesamten Prozesses stellt Merlin auch Spiele bereit, die Teil der offiziell vom Team erworbenen Bibliothek sind. Viele dieser Titel sind normalerweise nur über eine offizielle Lizenz zum vollen Preis oder über wenig vertrauenswürdige Methoden im Internet zugänglich. Das Ziel von Merlin ist es, der Community eine viel einfachere, organisierte und transparente Erfahrung zu bieten.",
    createTab: "Schlüssel erstellen",
    recoverTab: "Wiederherstellen",
    name: "Name",
    contact: "Kontakt",
    emailContact: "E-Mail",
    contactType: "Kontakttyp",
    phone: "Telefon",
    email: "E-Mail",
    pin: "Wiederherstellungs-PIN",
    contactHint: "Wir verwenden diese E-Mail nur für deinen Schlüssel, die Wiederherstellung und wichtige Hinweise.",
    pinHint: "Bewahre diese PIN auf. Sie wird zur Wiederherstellung deines Zugangsschlüssels benötigt.",
    notice: "Ich verstehe, dass mein Schlüssel möglicherweise nicht wiederhergestellt werden kann, wenn ich Kontakt oder PIN verliere.",
    createSubmit: "Meinen Zugangsschlüssel erstellen",
    recoverSubmit: "Meinen Zugangsschlüssel wiederherstellen",
    successCreated: "Dein Schlüssel wurde erstellt",
    successRecovered: "Dein Schlüssel wurde wiederhergestellt",
    successExisting: "Dein Zugangsschlüssel",
    successDescription: "Bewahre deinen Schlüssel sicher auf. Er wird für den Zugriff auf Merlin verwendet.",
    pinFinalNotice: "Speichere deine Wiederherstellungs-PIN jetzt. Sie wird nicht per E-Mail gesendet.",
    copyKey: "Schlüssel kopieren",
    copied: "Schlüssel kopiert",
    backToStart: "Zurück zum Anfang",
    loading: "Bitte warten...",
    errorName: "Gib deinen Namen ein.",
    errorContact: "Gib deinen Kontakt ein.",
    errorEmail: "Gib eine gültige E-Mail ein.",
    emailCode: "Bestätigungscode",
    emailVerificationTitle: "E-Mail bestätigen",
    emailVerificationSentTo: "Wir haben einen 6-stelligen Code gesendet an",
    confirmEmailCode: "Code bestätigen",
    resendEmailCode: "Code erneut senden",
    sendingCode: "Code wird gesendet...",
    emailCodeSent: "Code gesendet. Prüfe deine E-Mail und bei Bedarf den Spam-Ordner.",
    emailVerified: "E-Mail bestätigt. Zugangsschlüssel wird erstellt...",
    changeEmail: "Andere E-Mail verwenden",
    errorEmailCode: "Gib den 6-stelligen Code ein, der an deine E-Mail gesendet wurde.",
    errorPin: "Verwende eine PIN mit 4 bis 8 Zahlen.",
    errorNotice: "Bestätige den Wiederherstellungshinweis, um fortzufahren.",
    accessKeyUnavailable: "Mit diesen Daten konnte kein neuer Schlüssel erstellt werden. Wenn du bereits einen Schlüssel hast, nutze die Wiederherstellung.",
    recoveryUnavailable: "Mit diesen Daten konnte kein Schlüssel wiederhergestellt werden. Prüfe die Angaben und versuche es erneut.",
    genericError: "Die Anfrage konnte nicht abgeschlossen werden.",
  },
};

function detectBrowserLanguage() {
  const language = String(navigator.language || "en").toLowerCase();
  if (language.startsWith("pt")) return "ptbr";
  if (language.startsWith("es")) return "es";
  if (language.startsWith("fr")) return "fr";
  if (language.startsWith("de")) return "de";
  return "en";
}

function resolveLanguage() {
  const stored = localStorage.getItem("merlin_public_language");
  if (stored && messages[stored]) return stored;
  return detectBrowserLanguage();
}

let locale = resolveLanguage();
let text = { ...messages.en, ...(messages[locale] || {}) };
let versionState = { status: "loading", version: null };

function t(key, values) {
  let value = text[key] || messages.en[key] || key;
  for (const [name, replacement] of Object.entries(values || {})) {
    value = value.replace("{" + name + "}", String(replacement));
  }
  return value;
}

const recoverLink = document.getElementById("recoverLink");
const paymentStatusLink = document.getElementById("paymentStatusLink");
let billingPortalLink = document.getElementById("billingPortalLink");
const registerForm = document.getElementById("registerForm");
const emailVerificationForm = document.getElementById("emailVerificationForm");
const recoverForm = document.getElementById("recoverForm");
const paymentStatusForm = document.getElementById("paymentStatusForm");
let billingPortalForm = document.getElementById("billingPortalForm");
const paymentStatusResult = document.getElementById("paymentStatusResult");
const paymentStatusMark = document.getElementById("paymentStatusMark");
const paymentStatusResultTitle = document.getElementById("paymentStatusResultTitle");
const paymentStatusResultText = document.getElementById("paymentStatusResultText");
const paymentStatusKeyCard = document.getElementById("paymentStatusKeyCard");
const paymentStatusLicenseKey = document.getElementById("paymentStatusLicenseKey");
const copyPaymentStatusKey = document.getElementById("copyPaymentStatusKey");
const paymentStatusDownload = document.getElementById("paymentStatusDownload");
const retryPaymentStatus = document.getElementById("retryPaymentStatus");
const signupCard = document.getElementById("signupCard");
const planSelector = document.getElementById("planSelector");
const planOptions = document.getElementById("planOptions");
const languageSelect = document.getElementById("languageSelect");
const hero = document.querySelector(".hero");
const heroDescription = document.querySelector("[data-i18n='heroDescription']");
const benefits = document.querySelector(".benefits");
const message = document.getElementById("message");
const statusModal = document.getElementById("statusModal");
const statusModalMark = document.getElementById("statusModalMark");
const statusModalTitle = document.getElementById("statusModalTitle");
const statusModalText = document.getElementById("statusModalText");
const statusModalClose = document.getElementById("statusModalClose");
const result = document.getElementById("result");
const resultTitle = document.getElementById("resultTitle");
const licenseKey = document.getElementById("licenseKey");
const pinCard = document.getElementById("pinCard");
const recoveryPinValue = document.getElementById("recoveryPinValue");
const copyKey = document.getElementById("copyKey");
const backToStart = document.getElementById("backToStart");
const versionText = document.getElementById("versionText");
const verificationEmail = document.getElementById("verificationEmail");
const resendEmailCode = document.getElementById("resendEmailCode");
const changeEmail = document.getElementById("changeEmail");
const contactIconMap = {
  phone: "☎",
  email: "@",
  discord: "D",
};

function ensureBillingPortalUi() {
  if (!billingPortalLink) {
    const supportLinks = document.querySelector(".support-links");
    if (supportLinks) {
      supportLinks.insertAdjacentHTML("beforeend", '<button class="text-link" id="billingPortalLink" type="button" data-i18n="billingPortalInline">Manage monthly subscription</button>');
      billingPortalLink = document.getElementById("billingPortalLink");
    }
  }

  if (!billingPortalForm) {
    paymentStatusForm.insertAdjacentHTML("afterend", [
      '<form class="form-panel" id="billingPortalForm" hidden novalidate>',
      '<h2 class="form-title" data-i18n="billingPortalTitle">Manage monthly subscription</h2>',
      '<div class="field" data-field="contact">',
      '<span data-i18n="emailContact">E-mail</span>',
      '<div class="input-wrap">',
      '<span class="input-icon" aria-hidden="true">@</span>',
      '<input name="contact" type="email" autocomplete="email" inputmode="email" required />',
      '</div>',
      '<div class="field-error"></div>',
      '</div>',
      '<input name="contactType" type="hidden" value="email" />',
      '<p class="hint" data-i18n="billingPortalHint">Use the e-mail linked to your monthly Stripe subscription. Lifetime purchases do not have a subscription portal.</p>',
      '<button class="button primary" type="submit" data-default-key="billingPortalSubmit" data-default-text="Open portal">Open portal</button>',
      '<button class="button subtle" data-back-to-register type="button" data-i18n="backToCreate">Back to sign up</button>',
      '</form>',
    ].join(""));
    billingPortalForm = document.getElementById("billingPortalForm");
  }
}

ensureBillingPortalUi();

let emailVerificationState = {
  email: "",
  verified: false,
  cooldownUntil: 0,
  timer: null,
  pendingData: null,
  pendingMode: "register",
};

let paymentStatusState = {
  email: "",
  licenseKey: "",
};

let billingState = {
  billingEnabled: false,
  monthlyEnabled: false,
  lifetimeEnabled: false,
  prices: { monthly: null, lifetime: null },
};

function applyTranslations() {
  document.documentElement.lang = locale === "ptbr" ? "pt-BR" : locale;
  languageSelect.value = locale;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-default-key]").forEach((node) => {
    node.dataset.defaultText = t(node.dataset.defaultKey);
    if (!node.disabled) {
      node.textContent = node.dataset.defaultText;
    }
  });
  const signupEnabled = !signupCard.hidden;
  renderVersionText();
  versionText.hidden = false;
  benefits.hidden = false;
  heroDescription.textContent = signupEnabled ? t("heroDescription") : t("heroDescriptionDownloadOnly");
  renderBillingFaq();
  renderBillingPlans();
  updateEmailVerificationCooldownUi();
}

function renderBillingFaq() {
  const title = document.querySelector("[data-i18n='faqFreeTitle']");
  const body = document.querySelector("[data-i18n='faqFreeBody']");
  const paid = Boolean(billingState.billingEnabled);
  if (title) title.textContent = paid ? t("faqPaidTitle") : t("faqFreeTitle");
  if (body) body.textContent = paid ? t("faqPaidBody") : t("faqFreeBody");
}

function formatMoney(amountCents, currency) {
  return new Intl.NumberFormat(locale === "ptbr" ? "pt-BR" : "en-US", {
    style: "currency",
    currency: String(currency || "brl").toUpperCase(),
  }).format((Number(amountCents) || 0) / 100);
}

function formatPlanPrice(price, planType) {
  if (!price) {
    return "--";
  }
  const value = formatMoney(price.amountCents, price.currency);
  return planType === "monthly" ? value + " " + t("monthlyPriceSuffix") : value;
}

function selectedPlanType() {
  const checked = registerForm.querySelector("input[name='planType']:checked");
  return checked ? checked.value : "";
}

function setSelectedPlan(planType) {
  registerForm.querySelectorAll("input[name='planType']").forEach((input) => {
    input.checked = input.value === planType;
  });
  renderBillingPlans();
}

function renderBillingPlans() {
  const billingEnabled = Boolean(billingState.billingEnabled);
  renderBillingFaq();
  planSelector.hidden = !billingEnabled;
  const submitButton = registerForm.querySelector("button[type='submit']");
  if (submitButton) {
    const key = billingEnabled ? "checkoutSubmit" : "createSubmit";
    submitButton.dataset.defaultKey = key;
    submitButton.dataset.defaultText = t(key);
    if (!submitButton.disabled) {
      submitButton.textContent = submitButton.dataset.defaultText;
    }
  }

  ["monthly", "lifetime"].forEach((planType) => {
    const enabled = planType === "monthly" ? billingState.monthlyEnabled : billingState.lifetimeEnabled;
    const option = planOptions.querySelector("[data-plan-option='" + planType + "']");
    const input = option ? option.querySelector("input[name='planType']") : null;
    const price = option ? option.querySelector("[data-plan-price='" + planType + "']") : null;
    if (!option || !input || !price) return;
    option.hidden = !enabled;
    input.disabled = !enabled;
    option.classList.toggle("is-selected", input.checked);
    price.textContent = formatPlanPrice(billingState.prices?.[planType], planType);
  });

  if (billingEnabled && !selectedPlanType()) {
    const firstEnabled = billingState.monthlyEnabled ? "monthly" : billingState.lifetimeEnabled ? "lifetime" : "";
    if (firstEnabled) {
      setSelectedPlan(firstEnabled);
    }
  }
}

function setMode(mode) {
  closeStatusModal();
  const recovering = mode === "recover";
  const checkingPayment = mode === "payment-status";
  const managingBilling = mode === "billing-portal";
  const verifyingEmail = mode === "verify-email";
  result.classList.remove("active");
  result.hidden = true;
  paymentStatusResult.hidden = true;
  paymentStatusResult.classList.remove("is-processing", "is-missing");
  registerForm.hidden = recovering || checkingPayment || managingBilling || verifyingEmail;
  emailVerificationForm.hidden = !verifyingEmail;
  recoverForm.hidden = !recovering;
  paymentStatusForm.hidden = !checkingPayment;
  billingPortalForm.hidden = !managingBilling;
  message.textContent = "";
  message.classList.remove("ok");
  clearErrors(registerForm);
  clearErrors(emailVerificationForm);
  clearErrors(recoverForm);
  clearErrors(paymentStatusForm);
  clearErrors(billingPortalForm);
  if (recovering || checkingPayment || managingBilling) {
    resetEmailVerification();
  }
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function getField(form, name) {
  return form.querySelector("[data-field='" + name + "']");
}

function setFieldError(form, name, text) {
  const field = getField(form, name);
  const target = field ? field.querySelector(".field-error") : null;
  if (target) target.textContent = text || "";
}

function clearErrors(form) {
  form.querySelectorAll(".field-error").forEach((node) => { node.textContent = ""; });
  message.textContent = "";
  message.classList.remove("ok");
}

function setMessage(text, kind) {
  message.textContent = text || "";
  message.classList.toggle("ok", kind === "ok");
}

function showStatusModal(title, text, kind) {
  statusModalTitle.textContent = title || "";
  statusModalText.textContent = text || "";
  statusModal.classList.remove("is-ok", "is-warn", "is-error");
  if (kind === "ok") {
    statusModal.classList.add("is-ok");
    statusModalMark.textContent = "OK";
  } else if (kind === "warn") {
    statusModal.classList.add("is-warn");
    statusModalMark.textContent = "!";
  } else if (kind === "error") {
    statusModal.classList.add("is-error");
    statusModalMark.textContent = "!";
  } else {
    statusModalMark.textContent = "i";
  }
  statusModal.hidden = false;
  statusModalClose.focus();
}

function closeStatusModal() {
  statusModal.hidden = true;
}

function getFriendlyErrorMessage(error) {
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  if (rawMessage === "PUBLIC_ACCESS_KEY_UNAVAILABLE") {
    return t("accessKeyUnavailable");
  }
  if (rawMessage === "Could not recover this access key with the provided information") {
    return t("recoveryUnavailable");
  }
  if (rawMessage === "Email verification is required") {
    return t("emailVerificationRequired");
  }
  return rawMessage || t("genericError");
}

function setCheckboxError(text) {
  const target = registerForm.querySelector("[data-checkbox-error]");
  if (target) target.textContent = text || "";
}

function normalizeDigits(value) {
  return String(value || "").replace(/\\D/g, "");
}

function formatPhone(value) {
  const digits = normalizeDigits(value).slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return "(" + digits.slice(0, 2) + ") " + digits.slice(2);
  if (digits.length <= 10) return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 6) + "-" + digits.slice(6);
  return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 7) + "-" + digits.slice(7);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function resetEmailVerification() {
  emailVerificationState.email = "";
  emailVerificationState.verified = false;
  emailVerificationState.cooldownUntil = 0;
  emailVerificationState.pendingData = null;
  emailVerificationState.pendingMode = "register";
  if (emailVerificationState.timer) {
    clearTimeout(emailVerificationState.timer);
    emailVerificationState.timer = null;
  }
  updateEmailVerificationCooldownUi();
}

function getEmailCooldownSeconds() {
  return Math.max(0, Math.ceil((emailVerificationState.cooldownUntil - Date.now()) / 1000));
}

function updateEmailVerificationCooldownUi() {
  const cooldownSeconds = getEmailCooldownSeconds();
  resendEmailCode.disabled = cooldownSeconds > 0;
  resendEmailCode.textContent = cooldownSeconds > 0
    ? t("resendEmailCode") + " (" + cooldownSeconds + "s)"
    : t("resendEmailCode");

  if (cooldownSeconds > 0 && !emailVerificationState.timer) {
    emailVerificationState.timer = setTimeout(() => {
      emailVerificationState.timer = null;
      updateEmailVerificationCooldownUi();
    }, 1000);
  }
}

function validateForm(form) {
  clearErrors(form);
  const data = readForm(form);
  let valid = true;
  if (form === registerForm && !String(data.name || "").trim()) {
    setFieldError(form, "name", t("errorName"));
    valid = false;
  }
  if (!String(data.contact || "").trim()) {
    setFieldError(form, "contact", t("errorContact"));
    valid = false;
  }
  if (data.contactType === "email" && !/^\\S+@\\S+\\.\\S+$/.test(String(data.contact || "").trim())) {
    setFieldError(form, "contact", t("errorEmail"));
    valid = false;
  }
  if ((form === registerForm || form === recoverForm) && !/^\\d{4,8}$/.test(String(data.recoveryPin || "").trim())) {
    setFieldError(form, "recoveryPin", t("errorPin"));
    valid = false;
  }
  if (form === registerForm && data.acceptedRecoveryNotice !== "on") {
    setCheckboxError(t("errorNotice"));
    valid = false;
  }
  if (form === registerForm && billingState.billingEnabled && !selectedPlanType()) {
    const target = registerForm.querySelector("[data-plan-error]");
    if (target) target.textContent = t("errorPlan");
    valid = false;
  }
  return valid;
}

function setLoading(form, loading) {
  const button = form.querySelector("button[type='submit']");
  if (!button) return;
  button.disabled = loading;
  button.textContent = loading
    ? (form === registerForm && billingState.billingEnabled ? t("checkoutLoading") : form === paymentStatusForm ? t("paymentStatusLoading") : form === billingPortalForm ? t("billingPortalLoading") : t("loading"))
    : button.dataset.defaultText;
}

async function submitJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || t("genericError"));
  }
  return payload;
}

function buildRegisterPayload(data) {
  return {
    name: data.name,
    contact: data.contact,
    contactType: data.contactType,
    recoveryPin: data.recoveryPin,
    acceptedRecoveryNotice: data.acceptedRecoveryNotice === "on",
    planType: billingState.billingEnabled ? selectedPlanType() : undefined,
  };
}

function buildRecoverPayload(data) {
  return {
    contact: data.contact,
    contactType: data.contactType,
    recoveryPin: data.recoveryPin,
  };
}

function buildPaymentStatusPayload(data) {
  return {
    email: normalizeEmail(data.contact),
  };
}

function buildBillingPortalPayload(data) {
  return {
    email: normalizeEmail(data.contact),
  };
}

async function createAccessKeyFromPayload(payload) {
  if (billingState.billingEnabled) {
    const response = await submitJson("/api/public/checkout", {
      name: payload.name,
      contact: payload.contact,
      recoveryPin: payload.recoveryPin,
      acceptedRecoveryNotice: payload.acceptedRecoveryNotice,
      planType: payload.planType,
    });
    setMessage(t("checkoutRedirecting"), "ok");
    localStorage.setItem("merlin_checkout_email", normalizeEmail(payload.contact));
    window.location.href = response.checkoutUrl;
    return;
  }

  const response = await submitJson("/api/public/access-keys/register", payload);
  showKey(
    response.created ? t("successCreated") : t("successExisting"),
    response.license.licenseKey,
    response.created ? payload.recoveryPin : null,
  );
}

async function recoverAccessKeyFromPayload(payload) {
  const response = await submitJson("/api/public/access-keys/recover", payload);
  showKey(t("successRecovered"), response.license.licenseKey);
}

function showPaymentStatusResult(response, email) {
  const hasLicense = Boolean(response.license && response.license.licenseKey);
  const isExisting = response.status === "existing_license";
  const isCompleted = response.status === "completed";
  const isProcessing = response.status === "processing";
  const isExpired = response.status === "expired";
  const isMissing = response.status === "not_found";

  paymentStatusState.email = normalizeEmail(email);
  paymentStatusState.licenseKey = hasLicense ? response.license.licenseKey : "";
  paymentStatusResult.classList.toggle("is-processing", isProcessing);
  paymentStatusResult.classList.toggle("is-missing", isMissing || isExpired);
  paymentStatusMark.textContent = hasLicense ? "OK" : isProcessing ? "..." : "!";
  paymentStatusResultTitle.textContent = isCompleted
    ? t("paymentApprovedTitle")
    : isExisting
      ? t("paymentExistingTitle")
      : isProcessing
        ? t("paymentProcessingTitle")
        : isExpired
          ? t("paymentExpiredTitle")
          : t("paymentMissingTitle");
  paymentStatusResultText.textContent = isCompleted
    ? t("paymentApprovedText")
    : isExisting
      ? t("paymentExistingText")
      : isProcessing
        ? t("paymentProcessingText")
        : isExpired
          ? t("paymentExpiredText")
          : t("paymentMissingText");

  paymentStatusLicenseKey.textContent = paymentStatusState.licenseKey;
  paymentStatusKeyCard.hidden = !hasLicense;
  copyPaymentStatusKey.hidden = !hasLicense;
  paymentStatusDownload.hidden = !hasLicense;
  retryPaymentStatus.hidden = hasLicense;

  registerForm.hidden = true;
  emailVerificationForm.hidden = true;
  recoverForm.hidden = true;
  paymentStatusForm.hidden = true;
  result.hidden = true;
  result.classList.remove("active");
  message.textContent = "";
  message.classList.remove("ok");
  paymentStatusResult.hidden = false;
}

async function checkPaymentStatusFromPayload(payload) {
  const response = await submitJson("/api/public/payment-status", payload);
  showPaymentStatusResult(response, payload.email);
}

async function retryPaymentStatusCheck() {
  const email = normalizeEmail(paymentStatusState.email || paymentStatusForm.elements.contact.value);
  if (!email) {
    setMode("payment-status");
    return;
  }

  retryPaymentStatus.disabled = true;
  retryPaymentStatus.textContent = t("paymentStatusLoading");
  try {
    await checkPaymentStatusFromPayload({ email });
  } catch (error) {
    setMode("payment-status");
    paymentStatusForm.elements.contact.value = email;
    setMessage(getFriendlyErrorMessage(error));
  } finally {
    retryPaymentStatus.disabled = false;
    retryPaymentStatus.textContent = t("paymentStatusRetry");
  }
}

async function openBillingPortalFromPayload(payload) {
  const response = await submitJson("/api/public/billing-portal", payload);
  if (!response.portalUrl) {
    throw new Error(t("billingPortalUnavailable"));
  }
  setMessage(t("billingPortalRedirecting"), "ok");
  window.location.href = response.portalUrl;
}

async function sendEmailVerificationForPendingData() {
  const pendingData = emailVerificationState.pendingData;
  if (!pendingData) return;
  const email = normalizeEmail(pendingData.contact);
  if (!/^\\S+@\\S+\\.\\S+$/.test(email)) {
    setFieldError(registerForm, "contact", t("errorEmail"));
    return;
  }

  resendEmailCode.disabled = true;
  resendEmailCode.textContent = t("sendingCode");
  try {
    const payload = await submitJson("/api/public/email-verification/start", { email });
    emailVerificationState.email = email;
    emailVerificationState.verified = false;
    emailVerificationState.cooldownUntil = Date.now() + Number(payload.cooldownSeconds || 60) * 1000;
    verificationEmail.textContent = email;
    setMode("verify-email");
    emailVerificationForm.querySelector("input[name='emailCode']").focus();
    setMessage(t("emailCodeSent"), "ok");
  } catch (error) {
    setMessage(getFriendlyErrorMessage(error));
  } finally {
    updateEmailVerificationCooldownUi();
  }
}

async function confirmPendingEmailCode() {
  clearErrors(emailVerificationForm);
  const pendingData = emailVerificationState.pendingData;
  if (!pendingData) {
    setMode("register");
    return;
  }
  const email = normalizeEmail(pendingData.contact);
  const data = readForm(emailVerificationForm);
  const code = String(data.emailCode || "").trim();
  if (!/^\\d{6}$/.test(code)) {
    setFieldError(emailVerificationForm, "emailCode", t("errorEmailCode"));
    return;
  }

  await submitJson("/api/public/email-verification/verify", { email, code });
  emailVerificationState.email = email;
  emailVerificationState.verified = true;
  setMessage(billingState.billingEnabled && emailVerificationState.pendingMode === "register" ? t("checkoutLoading") : t("emailVerified"), "ok");
  if (emailVerificationState.pendingMode === "recover") {
    await recoverAccessKeyFromPayload(buildRecoverPayload(pendingData));
    return;
  }
  if (emailVerificationState.pendingMode === "payment-status") {
    await checkPaymentStatusFromPayload(buildPaymentStatusPayload(pendingData));
    return;
  }
  if (emailVerificationState.pendingMode === "billing-portal") {
    await openBillingPortalFromPayload(buildBillingPortalPayload(pendingData));
    return;
  }
  await createAccessKeyFromPayload(buildRegisterPayload(pendingData));
}

function showKey(title, key, recoveryPin) {
  closeStatusModal();
  resultTitle.textContent = title;
  licenseKey.textContent = key;
  if (recoveryPin) {
    recoveryPinValue.textContent = recoveryPin;
    pinCard.hidden = false;
  } else {
    recoveryPinValue.textContent = "";
    pinCard.hidden = true;
  }
  registerForm.hidden = true;
  emailVerificationForm.hidden = true;
  recoverForm.hidden = true;
  paymentStatusForm.hidden = true;
  billingPortalForm.hidden = true;
  paymentStatusResult.hidden = true;
  message.textContent = "";
  result.hidden = false;
  result.classList.add("active");
}

function showCheckoutReturnMessage() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get("checkout");
  if (checkout === "success") {
    showStatusModal(t("checkoutReceivedTitle"), t("checkoutSuccessPending"), "ok");
    pollCheckoutStatus(params.get("session_id"));
  } else if (checkout === "cancel") {
    showStatusModal(t("checkoutCanceledTitle"), t("checkoutCanceled"), "warn");
  }
}

async function pollCheckoutStatus(sessionId) {
  if (!sessionId) {
    return;
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const payload = await fetch("/api/public/checkout-status?session_id=" + encodeURIComponent(sessionId)).then((response) => response.json());
      if (payload && payload.success !== false && payload.status === "completed" && payload.license) {
        showKey(t("successCreated"), payload.license.licenseKey, null);
        return;
      }
    } catch {
      // Keep polling for a short period; the webhook may still be processing.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  setMode("payment-status");
  const email = localStorage.getItem("merlin_checkout_email") || "";
  if (email) {
    paymentStatusForm.elements.contact.value = email;
  }
  showStatusModal(t("checkoutStillProcessingTitle"), t("checkoutStillProcessing"), "warn");
}

function renderVersionText() {
  if (versionState.status === "current" && versionState.version) {
    versionText.textContent = t("versionCurrent", { version: versionState.version });
    return;
  }

  if (versionState.status === "available") {
    versionText.textContent = t("versionAvailable");
    return;
  }

  if (versionState.status === "download") {
    versionText.textContent = t("downloadAvailable");
    return;
  }

  versionText.textContent = t("versionLoading");
}

async function loadVersion() {
  versionState = { status: "loading", version: null };
  renderVersionText();
  try {
    const payload = await fetch("/api/updates/latest").then((response) => response.json());
    versionState = payload.version
      ? { status: "current", version: payload.version }
      : { status: "available", version: null };
  } catch {
    versionState = { status: "download", version: null };
  }
  renderVersionText();
}

async function loadPublicSettings() {
  try {
    const payload = await fetch("/api/billing/settings-public").then((response) => response.json());
    const enabled = Boolean(payload && payload.success !== false && payload.settings && payload.settings.enabled);
    billingState = {
      billingEnabled: Boolean(payload?.billing?.billingEnabled),
      monthlyEnabled: Boolean(payload?.billing?.monthlyEnabled),
      lifetimeEnabled: Boolean(payload?.billing?.lifetimeEnabled),
      prices: payload?.billing?.prices || { monthly: null, lifetime: null },
    };
    signupCard.hidden = !enabled;
    hero.classList.toggle("signup-closed", !enabled);
    versionText.hidden = false;
    benefits.hidden = false;
    heroDescription.textContent = enabled ? t("heroDescription") : t("heroDescriptionDownloadOnly");
    document.querySelectorAll(".signup-copy").forEach((node) => {
      node.hidden = false;
    });
    renderBillingPlans();
  } catch {
    billingState = { billingEnabled: false, monthlyEnabled: false, lifetimeEnabled: false, prices: { monthly: null, lifetime: null } };
    signupCard.hidden = true;
    hero.classList.add("signup-closed");
    versionText.hidden = false;
    benefits.hidden = false;
    heroDescription.textContent = t("heroDescriptionDownloadOnly");
    document.querySelectorAll(".signup-copy").forEach((node) => {
      node.hidden = false;
    });
    renderBillingPlans();
  }
}

function setContactType(form, type) {
  form.querySelector("input[name='contactType']").value = "email";
  form.querySelectorAll("[data-contact-icon]").forEach((icon) => {
    icon.textContent = "@";
  });
  const contact = form.querySelector("input[name='contact']");
  if (!contact) return;
  contact.type = "email";
  contact.autocomplete = "email";
  contact.inputMode = "email";
  clearErrors(form);
  if (form === registerForm) {
    resetEmailVerification();
  }
}

document.querySelectorAll("input[name='contact']").forEach((input) => {
  input.addEventListener("input", () => {
    const form = input.closest("form");
    const type = form.querySelector("input[name='contactType']").value;
    if (form === registerForm && type === "email" && emailVerificationState.email !== normalizeEmail(input.value)) {
      emailVerificationState.verified = false;
    }
    updateEmailVerificationCooldownUi();
  });
});

planOptions.querySelectorAll("input[name='planType']").forEach((input) => {
  input.addEventListener("change", () => {
    const target = registerForm.querySelector("[data-plan-error]");
    if (target) target.textContent = "";
    renderBillingPlans();
  });
});

document.querySelectorAll(".faq-question").forEach((button) => {
  button.addEventListener("click", () => {
    const item = button.closest(".faq-item");
    const shouldOpen = !item.classList.contains("is-open");
    document.querySelectorAll(".faq-item").forEach((entry) => {
      entry.classList.remove("is-open");
      entry.querySelector(".faq-question")?.setAttribute("aria-expanded", "false");
    });
    if (shouldOpen) {
      item.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
    }
  });
});

recoverLink.addEventListener("click", () => setMode("recover"));
paymentStatusLink.addEventListener("click", () => setMode("payment-status"));
billingPortalLink.addEventListener("click", () => setMode("billing-portal"));
statusModalClose.addEventListener("click", closeStatusModal);
statusModal.querySelector("[data-close-status-modal]").addEventListener("click", closeStatusModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !statusModal.hidden) {
    closeStatusModal();
  }
});
document.querySelectorAll("[data-back-to-register]").forEach((button) => {
  button.addEventListener("click", () => setMode("register"));
});
resendEmailCode.addEventListener("click", sendEmailVerificationForPendingData);
changeEmail.addEventListener("click", () => {
  const previousMode = emailVerificationState.pendingMode;
  emailVerificationForm.reset();
  setMode(previousMode === "recover"
    ? "recover"
    : previousMode === "payment-status"
      ? "payment-status"
      : previousMode === "billing-portal"
        ? "billing-portal"
        : "register");
});
languageSelect.addEventListener("change", () => {
  const next = languageSelect.value;
  if (!messages[next]) return;
  locale = next;
  text = { ...messages.en, ...messages[locale] };
  localStorage.setItem("merlin_public_language", locale);
  applyTranslations();
});
copyKey.addEventListener("click", async () => {
  await navigator.clipboard.writeText(licenseKey.textContent || "");
  copyKey.textContent = t("copied");
  setTimeout(() => { copyKey.textContent = t("copyKey"); }, 1600);
});
copyPaymentStatusKey.addEventListener("click", async () => {
  await navigator.clipboard.writeText(paymentStatusState.licenseKey || paymentStatusLicenseKey.textContent || "");
  copyPaymentStatusKey.textContent = t("copied");
  setTimeout(() => { copyPaymentStatusKey.textContent = t("copyKey"); }, 1600);
});
retryPaymentStatus.addEventListener("click", retryPaymentStatusCheck);
backToStart.addEventListener("click", () => {
  registerForm.reset();
  recoverForm.reset();
  paymentStatusForm.reset();
  billingPortalForm.reset();
  recoveryPinValue.textContent = "";
  pinCard.hidden = true;
  paymentStatusState = { email: "", licenseKey: "" };
  resetEmailVerification();
  setContactType(registerForm, "email");
  setContactType(recoverForm, "email");
  setContactType(paymentStatusForm, "email");
  setContactType(billingPortalForm, "email");
  setMode("register");
});
registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm(registerForm)) return;
  const data = readForm(registerForm);
  setLoading(registerForm, true);
  try {
    if (data.contactType === "email") {
      emailVerificationState.pendingData = data;
      emailVerificationState.pendingMode = "register";
      await sendEmailVerificationForPendingData();
      return;
    }
    await createAccessKeyFromPayload(buildRegisterPayload(data));
  } catch (error) {
    message.textContent = getFriendlyErrorMessage(error);
  } finally {
    setLoading(registerForm, false);
  }
});

emailVerificationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(emailVerificationForm, true);
  try {
    await confirmPendingEmailCode();
  } catch (error) {
    setMessage(getFriendlyErrorMessage(error));
  } finally {
    setLoading(emailVerificationForm, false);
  }
});

recoverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm(recoverForm)) return;
  const data = readForm(recoverForm);
  setLoading(recoverForm, true);
  try {
    if (data.contactType === "email") {
      emailVerificationState.pendingData = data;
      emailVerificationState.pendingMode = "recover";
      await sendEmailVerificationForPendingData();
      return;
    }
    await recoverAccessKeyFromPayload(buildRecoverPayload(data));
  } catch (error) {
    message.textContent = getFriendlyErrorMessage(error);
  } finally {
    setLoading(recoverForm, false);
  }
});

paymentStatusForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm(paymentStatusForm)) return;
  const data = readForm(paymentStatusForm);
  setLoading(paymentStatusForm, true);
  try {
    emailVerificationState.pendingData = data;
    emailVerificationState.pendingMode = "payment-status";
    await sendEmailVerificationForPendingData();
  } catch (error) {
    message.textContent = getFriendlyErrorMessage(error);
  } finally {
    setLoading(paymentStatusForm, false);
  }
});

billingPortalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateForm(billingPortalForm)) return;
  const data = readForm(billingPortalForm);
  setLoading(billingPortalForm, true);
  try {
    emailVerificationState.pendingData = data;
    emailVerificationState.pendingMode = "billing-portal";
    await sendEmailVerificationForPendingData();
  } catch (error) {
    message.textContent = getFriendlyErrorMessage(error);
  } finally {
    setLoading(billingPortalForm, false);
  }
});

applyTranslations();
setContactType(registerForm, "email");
setContactType(recoverForm, "email");
setContactType(paymentStatusForm, "email");
setContactType(billingPortalForm, "email");
showCheckoutReturnMessage();
loadPublicSettings();
loadVersion();
`;
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

function getPublicBillingPayload(billing: Awaited<ReturnType<typeof getBillingSettings>>) {
  const mapPrice = (price: typeof billing.prices.monthly) => price
    ? {
        productName: price.productName,
        amountCents: price.amountCents,
        currency: price.currency,
        recurringInterval: price.recurringInterval,
        active: price.active,
        syncedAt: price.syncedAt,
        stale: price.stale,
      }
    : null;

  return {
    billingEnabled: billing.billingEnabled,
    monthlyEnabled: billing.monthlyEnabled,
    lifetimeEnabled: billing.lifetimeEnabled,
    prices: {
      monthly: mapPrice(billing.prices.monthly),
      lifetime: mapPrice(billing.prices.lifetime),
    },
  };
}

function queuePublicEmail(c: { executionCtx: { waitUntil(task: Promise<unknown>): void } }, label: string, task: Promise<unknown>) {
  c.executionCtx.waitUntil(task.catch((error) => {
    console.warn(`[public-email] ${label} failed`, error instanceof Error ? error.message : error);
  }));
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

function resolvePremiumGameUploadTarget(appId: string, uploadName: string) {
  if (!/^\d+$/.test(appId)) {
    throw new HTTPException(400, { message: "Informe um appId numerico valido." });
  }

  const safeName = sanitizeOverrideFilename(uploadName);
  if (!/\.zip$/i.test(safeName)) {
    throw new HTTPException(400, { message: "Premium activation aceita apenas arquivos .zip." });
  }

  return {
    safeName,
    objectKey: `${appId}/${appId}.zip`,
  };
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

function validatePremiumGameUploadObjectKey(appId: string, objectKey: string) {
  const normalizedAppId = String(appId || "").trim();
  if (!/^\d+$/.test(normalizedAppId)) {
    throw new HTTPException(400, { message: "Invalid appId" });
  }

  const normalized = String(objectKey || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("..") || normalized.startsWith("/")) {
    throw new HTTPException(400, { message: "Invalid premium activation object key" });
  }

  const target = resolvePremiumGameUploadTarget(normalizedAppId, `${normalizedAppId}.zip`);
  if (normalized !== target.objectKey) {
    throw new HTTPException(400, { message: "Invalid premium activation object key" });
  }

  return target;
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
    return c.redirect("/overview", 302);
  }

  clearAdminSessionCookie(c);
  return servePanelApp(c);
});

app.get("/", servePublicDownloadApp);
app.get("/download", servePublicDownloadApp);
app.get("/download/", servePublicDownloadApp);

app.get("/download.js", () => {
  return new Response(renderPublicDownloadScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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

app.get("/panel-api/premium/games", async (c) => {
  await requireAdminSession(c);
  const games = await listPremiumGames(c);
  return c.json({ games }, 200);
});

app.get("/panel-api/premium/games/:appId", async (c) => {
  await requireAdminSession(c);
  const game = await getPremiumGame(c, c.req.param("appId"));
  if (!game) {
    throw new HTTPException(404, { message: "Premium game not found" });
  }

  return c.json({ game }, 200);
});

app.post("/panel-api/premium/games", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(premiumGameCreateSchema, await c.req.json());
  const game = await createPremiumGame(c, body);
  return c.json({ success: true, game }, 201);
});

app.put("/panel-api/premium/games/:appId", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(premiumGameUpdateSchema, await c.req.json());
  const game = await updatePremiumGame(c, c.req.param("appId"), body);
  return c.json({ success: true, game }, 200);
});

app.delete("/panel-api/premium/games/:appId", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const deleted = await deletePremiumGame(c, c.req.param("appId"));
  if (!deleted) {
    throw new HTTPException(404, { message: "Premium game not found" });
  }

  return c.json({ success: true, appId: c.req.param("appId") }, 200);
});

app.post("/panel-api/premium/games/upload/initiate", async (c) => {
  await requireAdminSession(c, { mutate: true });

  const body = parseBody(premiumGameUploadInitSchema, await c.req.json());
  const target = resolvePremiumGameUploadTarget(body.appId, body.filename);

  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS binding is not configured" });
  }

  const upload = await c.env.MERLIN_ACTIVATIONS.createMultipartUpload(target.objectKey, {
    httpMetadata: {
      contentType: "application/zip",
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    appId: body.appId,
    uploadId: upload.uploadId,
    objectKey: target.objectKey,
    filename: target.safeName,
    partSize: OVERRIDE_UPLOAD_PART_SIZE,
    sizeBytes: body.sizeBytes,
    sizeLabel: formatUploadSize(body.sizeBytes),
  }, 200);
});

app.post("/panel-api/premium/games/upload/part", async (c) => {
  await requireAdminSession(c, { mutate: true });

  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS binding is not configured" });
  }

  const appId = String(c.req.query("appId") || "").trim();
  const uploadId = String(c.req.query("uploadId") || "").trim();
  const objectKey = String(c.req.query("objectKey") || "").trim();
  const partNumber = Number(c.req.query("partNumber") || "0");

  if (!uploadId || !Number.isInteger(partNumber) || partNumber <= 0) {
    throw new HTTPException(400, { message: "Invalid multipart upload request" });
  }

  const target = validatePremiumGameUploadObjectKey(appId, objectKey);
  const body = c.req.raw.body;
  if (!body) {
    throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
  }

  const upload = c.env.MERLIN_ACTIVATIONS.resumeMultipartUpload(target.objectKey, uploadId);
  const uploadedPart = await upload.uploadPart(partNumber, body);
  return c.json(uploadedPart, 200);
});

app.post("/panel-api/premium/games/upload/complete", async (c) => {
  await requireAdminSession(c, { mutate: true });

  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS binding is not configured" });
  }

  const body = parseBody(premiumGameUploadCompleteSchema, await c.req.json());
  const target = validatePremiumGameUploadObjectKey(body.appId, body.objectKey);
  const expectedUpload = resolvePremiumGameUploadTarget(body.appId, body.filename);
  if (target.objectKey !== expectedUpload.objectKey) {
    throw new HTTPException(400, { message: "Invalid premium activation file name" });
  }

  const upload = c.env.MERLIN_ACTIVATIONS.resumeMultipartUpload(target.objectKey, body.uploadId);
  const uploadedParts = [...body.uploadedParts].sort((left, right) => left.partNumber - right.partNumber);
  await upload.complete(uploadedParts);

  return c.json({
    success: true,
    appId: body.appId,
    objectKey: target.objectKey,
    filename: target.safeName,
    sizeBytes: body.sizeBytes,
    sizeLabel: formatUploadSize(body.sizeBytes),
  }, 200);
});

app.post("/panel-api/premium/games/upload/abort", async (c) => {
  await requireAdminSession(c, { mutate: true });

  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS binding is not configured" });
  }

  const body = parseBody(premiumGameUploadAbortSchema, await c.req.json());
  const target = validatePremiumGameUploadObjectKey(body.appId, body.objectKey);
  const upload = c.env.MERLIN_ACTIVATIONS.resumeMultipartUpload(target.objectKey, body.uploadId);
  await upload.abort();

  return c.json({ success: true }, 200);
});

app.post("/panel-api/premium/games/upload", async (c) => {
  await requireAdminSession(c, { mutate: true });

  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS binding is not configured" });
  }

  const contentType = c.req.header("content-type") || "";
  let appId = "";
  let uploadName = "arquivo.zip";
  let sizeBytes = 0;
  let uploadBody: ReadableStream | ArrayBuffer | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");

    appId = String(formData.get("appId") || "").trim();
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
    }

    uploadName = file.name || "arquivo.zip";
    sizeBytes = file.size || 0;
    uploadBody = await file.arrayBuffer();
  } else {
    appId = String(c.req.query("appId") || "").trim();
    uploadName = c.req.header("x-upload-filename") || "arquivo.zip";

    const headerSize = Number(c.req.header("x-upload-size") || c.req.header("content-length") || "0");
    sizeBytes = Number.isFinite(headerSize) ? headerSize : 0;
    uploadBody = c.req.raw.body;

    if (!uploadBody) {
      throw new HTTPException(400, { message: "Selecione um arquivo para enviar." });
    }
  }

  const target = resolvePremiumGameUploadTarget(appId, uploadName);
  if (sizeBytes <= 0) {
    throw new HTTPException(400, { message: "O arquivo enviado está vazio." });
  }

  await c.env.MERLIN_ACTIVATIONS.put(target.objectKey, uploadBody, {
    httpMetadata: {
      contentType: "application/zip",
      cacheControl: "no-store",
    },
  });

  return c.json({
    success: true,
    appId,
    objectKey: target.objectKey,
    filename: target.safeName,
    sizeBytes,
    sizeLabel: formatUploadSize(sizeBytes),
  }, 200);
});

app.get("/panel-api/polls", async (c) => {
  await requireAdminSession(c);
  const polls = await listPolls(c);
  return c.json({ polls }, 200);
});

app.post("/panel-api/polls", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(pollUpsertSchema, await c.req.json());
  const poll = await createPoll(c, body);
  return c.json({ success: true, poll }, 201);
});

app.put("/panel-api/polls/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(pollUpsertSchema, await c.req.json());
  const poll = await updatePoll(c, c.req.param("id"), body);
  return c.json({ success: true, poll }, 200);
});

app.post("/panel-api/polls/:id/open", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const poll = await setPollStatus(c, c.req.param("id"), "open");
  return c.json({ success: true, poll }, 200);
});

app.post("/panel-api/polls/:id/close", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const poll = await setPollStatus(c, c.req.param("id"), "closed");
  return c.json({ success: true, poll }, 200);
});

app.delete("/panel-api/polls/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  return c.json(await deletePoll(c, c.req.param("id")), 200);
});

app.post("/panel-api/overrides", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(OverrideUpsertRequest, await c.req.json());
  const override = await upsertOverride(c.env, body.appId, {
    name: body.name,
    adminNote: body.adminNote,
    hidden: body.hidden,
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
    throw new HTTPException(400, { message: "O arquivo enviado está vazio." });
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

app.get("/api/public/access-keys/settings", async (c) => {
  const settings = await getPublicSignupSettings(c);
  const billing = await getBillingSettings(c);
  return c.json({
    success: true,
    settings: { enabled: settings.enabled },
    billing: getPublicBillingPayload(billing),
  }, 200);
});

app.get("/api/billing/settings-public", async (c) => {
  const settings = await getPublicSignupSettings(c);
  const billing = await getBillingSettings(c);
  return c.json({
    success: true,
    settings: { enabled: settings.enabled },
    billing: getPublicBillingPayload(billing),
  }, 200);
});

app.post("/api/public/checkout", async (c) => {
  const body = parseBody(publicCheckoutSchema, await c.req.json());
  try {
    const result = await createPublicStripeCheckout(c, body);
    return c.json({ success: true, ...result }, 201);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error || "Unknown checkout error");
    console.error("[public-checkout:error]", { message });
    if (c.env.ENVIRONMENT === "staging") {
      return c.json({ success: false, error: `Checkout debug: ${message}` }, 500);
    }
    throw error;
  }
});

app.get("/api/public/checkout-status", async (c) => {
  const query = parseBody(publicCheckoutStatusQuerySchema, c.req.query());
  const result = await getPublicCheckoutStatus(c, query.session_id);
  return c.json({ success: true, ...result }, 200);
});

app.post("/api/public/payment-status", async (c) => {
  const body = parseBody(publicCheckoutStatusByEmailSchema, await c.req.json());
  const result = await getPublicCheckoutStatusByEmail(c, body.email);
  return c.json({ success: true, ...result }, 200);
});

app.post("/api/public/billing-portal", async (c) => {
  const body = parseBody(publicBillingPortalSchema, await c.req.json());
  const result = await createPublicBillingPortalSession(c, body.email);
  return c.json({ success: true, ...result }, 200);
});

app.post("/api/public/access/me", async (c) => {
  const body = parseBody(publicAccessMeSchema, await c.req.json());
  const result = await getPublicAccessDetails(c, body);
  return c.json({ success: true, ...result }, 200);
});

app.post("/api/public/access/upgrade-checkout", async (c) => {
  const body = parseBody(publicAccessMeSchema, await c.req.json());
  const result = await createPublicAccessUpgradeCheckout(c, body);
  return c.json({ success: true, ...result }, 201);
});

app.post("/api/public/access/billing-portal", async (c) => {
  const body = parseBody(publicAccessMeSchema, await c.req.json());
  const result = await createPublicAccessBillingPortal(c, body);
  return c.json({ success: true, ...result }, 200);
});

app.get("/api/public/access/upgrade-status", async (c) => {
  const query = parseBody(publicAccessUpgradeStatusQuerySchema, c.req.query());
  const result = await getPublicAccessUpgradeStatus(c, query.session_id);
  return c.json({ success: true, ...result }, 200);
});

app.on("POST", ["/api/stripe/webhook", "/payment/webhooks/stripe"], handleStripeWebhook);

app.post("/api/public/access-keys/register", async (c) => {
  const body = parseBody(publicAccessKeySchema, await c.req.json());
  const billing = await getBillingSettings(c);
  if (billing.billingEnabled) {
    throw new HTTPException(409, { message: "Pagamento público está ativo para novos cadastros." });
  }
  const contact = normalizePublicAccessContact(body.contact, body.contactType);
  await enforcePublicAccessKeyRateLimit(c, `${body.contactType}:${contact}`);
  const result = await registerPublicAccessKey(c, { ...body, contact });
  if (body.contactType === "email" && result.created) {
    queuePublicEmail(c, "welcome-access-key", sendWelcomeAccessKeyEmail(c, {
      email: contact,
      name: result.license.name,
      licenseKey: result.license.licenseKey,
    }));
  }
  return c.json({ success: true, ...result }, result.created ? 201 : 200);
});

app.post("/api/public/access-keys/recover", async (c) => {
  const body = parseBody(publicAccessKeyRecoverySchema, await c.req.json());
  const contact = normalizePublicAccessContact(body.contact, body.contactType);
  await enforcePublicAccessKeyRateLimit(c, `${body.contactType}:${contact}`);
  const result = await recoverPublicAccessKey(c, { ...body, contact });
  if (body.contactType === "email") {
    queuePublicEmail(c, "recovered-access-key", sendRecoveredAccessKeyEmail(c, {
      email: contact,
      name: result.license.name,
      licenseKey: result.license.licenseKey,
    }));
  }
  return c.json({ success: true, ...result }, 200);
});

app.get("/panel-api/public-signup", async (c) => {
  await requireAdminSession(c);
  const settings = await getPublicSignupSettings(c);
  const billing = await getBillingSettings(c);
  const metrics = await getPublicSignupMetrics(c);
  return c.json({ settings: getPublicSignupSettingsPayload(settings), billing, metrics }, 200);
});

app.put("/panel-api/public-signup", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(publicSignupSettingsSchema, await c.req.json());
  const settings = await updatePublicSignupSettings(c, body);
  const billing = body.billing
    ? await updateBillingSettings(c, { ...body.billing, publicSignupEnabled: body.enabled })
    : await getBillingSettings(c);
  const metrics = await getPublicSignupMetrics(c);
  return c.json({ settings: getPublicSignupSettingsPayload(settings), billing, metrics }, 200);
});

app.get("/panel-api/payments", async (c) => {
  await requireAdminSession(c);
  const limit = Number(c.req.query("limit") || "120");
  const payload = await listAdminPaymentLogs(c, Number.isFinite(limit) ? limit : 120);
  return c.json(payload, 200);
});

app.post("/panel-api/payments/checkouts/:sessionId/sync-stripe", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const sessionId = c.req.param("sessionId");
  const result = await reconcileStripeCheckoutSession(c, sessionId);
  await writeAdminAuditLog(c, {
    adminUserId: session.session.admin_user_id,
    action: "payment_checkout_synced",
    entityType: "checkout",
    entityId: sessionId,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
    metadata: {
      sessionId,
      paymentStatus: result.paymentStatus,
      stripeStatus: result.stripeStatus,
      subscriptionId: result.subscriptionId,
      invoiceId: result.invoiceId,
    },
  });
  return c.json({ success: true, result }, 200);
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
  if (created.contact_type === "email") {
    queuePublicEmail(c, "admin-welcome-access-key", sendWelcomeAccessKeyEmail(c, {
      email: created.contact,
      name: created.name,
      licenseKey: created.license_key,
    }));
  }
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

app.post("/panel-api/licenses/:id/send-welcome-email", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const license = await getLicense(c, parseLicenseId(c.req.param("id")));
  if (license.contact_type !== "email") {
    throw new HTTPException(400, { message: "This license contact is not an email" });
  }

  await sendWelcomeAccessKeyEmail(c, {
    email: license.contact,
    name: license.name,
    licenseKey: license.license_key,
  });
  await writeAdminAuditLog(c, {
    adminUserId: session.session.admin_user_id,
    action: "license_welcome_email_sent",
    entityType: "license",
    entityId: String(license.id),
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
    metadata: { email: license.contact },
  });

  return c.json({ success: true }, 200);
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

app.post("/panel-api/licenses/:id/sync-stripe", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const licenseId = parseLicenseId(c.req.param("id"));
  const result = await reconcileStripeLicense(c, licenseId);
  await writeAdminAuditLog(c, {
    adminUserId: session.session.admin_user_id,
    action: "payment_license_synced",
    entityType: "license",
    entityId: String(licenseId),
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
    metadata: {
      licenseId,
      sessionId: result.checkout?.sessionId || null,
      subscriptionId: result.subscriptionId,
    },
  });
  const updated = await getLicense(c, licenseId);
  return c.json({ success: true, result, license: mapLicense(updated) }, 200);
});

app.get("/api/premium/catalog", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const games = await listPremiumCatalog(c, license.id);

  return c.json({
    success: true,
    games,
  }, 200);
});

app.post("/api/premium/activate", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const body = parseBody(premiumActivationRequestSchema, await c.req.json());

  let reservation: Awaited<ReturnType<typeof reservePremiumActivation>>;
  try {
    reservation = await reservePremiumActivation(c, license.id, body.appId);
  } catch (error) {
    const game = await getPremiumGame(c, body.appId).catch(() => null);
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: game?.name || null,
      reason: "premium_reservation_failed",
      metadata: {
        stage: "reservation",
        activationType: game?.activationType || null,
        error: getErrorMessage(error),
        httpStatus: getErrorStatus(error),
      },
    });
    throw error;
  }

  if (reservation.game.activationType === "third_party") {
    return c.json({
      success: true,
      appId: body.appId,
      activationType: reservation.game.activationType,
      reservationId: reservation.reservationId,
      activation: {
        appId: body.appId,
        reservationId: reservation.reservationId,
        archiveFileName: `${body.appId}.zip`,
        archiveKey: reservation.game.archiveKey,
        archiveDownloadPath: getPremiumDownloadPath(body.appId),
        archiveDownloadUrl: getPremiumDownloadUrl(c, body.appId),
        launchExecutablePath: reservation.game.launchExecutablePath,
      },
      cooldownUntil: null,
    }, 200);
  }

  const steamAccountId = String(c.env.STEAM_ACCOUNT_ID || "").trim();
  if (!steamAccountId) {
    await failPremiumActivationReservation(
      c,
      reservation.reservationId,
      "configuration",
      "STEAM_ACCOUNT_ID is not configured",
    );
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: reservation.game.name,
      reason: "premium_configuration_failed",
      metadata: {
        stage: "configuration",
        activationType: reservation.game.activationType,
        reservationId: reservation.reservationId,
        error: "STEAM_ACCOUNT_ID is not configured",
      },
    });
    throw new HTTPException(500, { message: "STEAM_ACCOUNT_ID is not configured" });
  }

  let worker: Awaited<ReturnType<typeof callMerlinWorker>> | null = null;
  try {
    worker = await callMerlinWorker(c, body.appId, steamAccountId);
    if (!worker.ok) {
      await failPremiumActivationReservation(
        c,
        reservation.reservationId,
        "worker_call",
        worker.error?.upstreamBody || worker.error?.message || "Merlin worker request failed",
      );
      await writePremiumActivityLog(c, license, {
        action: "premium_activation_failed",
        status: "denied",
        appId: body.appId,
        gameName: reservation.game.name,
        reason: "premium_worker_failed",
        metadata: {
          stage: "worker_call",
          activationType: reservation.game.activationType,
          reservationId: reservation.reservationId,
          worker: getPremiumWorkerLogPayload(worker),
        },
      });

      return c.json({
        success: false,
        stage: "worker_call",
        error: worker.error?.message || "Merlin worker request failed",
        worker: {
          status: worker.status,
          ok: worker.ok,
          payload: worker.payload,
          error: worker.error,
        },
      }, 502);
    }

    const completion = await completePremiumActivation(c, reservation.reservationId);
    const activation = getPremiumActivationPayload(
      worker,
      body.appId,
      steamAccountId,
      reservation.game.archiveKey,
      c,
    );
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_success",
      status: "success",
      appId: body.appId,
      gameName: reservation.game.name,
      metadata: {
        stage: "completed",
        activationType: reservation.game.activationType,
        reservationId: reservation.reservationId,
        archiveKey: reservation.game.archiveKey,
        cooldownUntil: completion.cooldownUntil,
      },
    });

    return c.json({
      success: true,
      appId: body.appId,
      steamAccountId,
      activation,
      cooldownUntil: completion.cooldownUntil,
    }, 200);
  } catch (error) {
    if (!worker || !worker.ok) {
      const failureStage = worker ? "activation_unhandled" : "worker_call";
      const failureReason = worker ? "premium_activation_unhandled" : "premium_worker_unreachable";
      await failPremiumActivationReservation(
        c,
        reservation.reservationId,
        failureStage,
        error instanceof Error ? error.message : "Unknown activation error",
      );
      await writePremiumActivityLog(c, license, {
        action: "premium_activation_failed",
        status: "denied",
        appId: body.appId,
        gameName: reservation.game.name,
        reason: failureReason,
        metadata: {
          stage: failureStage,
          activationType: reservation.game.activationType,
          reservationId: reservation.reservationId,
          error: getErrorMessage(error),
          worker: getPremiumWorkerLogPayload(worker),
        },
      });
    }

    throw error;
  }
});

app.post("/api/premium/activate-third-party", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const body = parseBody(premiumThirdPartyActivationRequestSchema, await c.req.json());
  const game = await assertPremiumDownloadAccess(c, license.id, body.appId);
  const reservationId = body.reservationId
    || await findPremiumActivationReservationForLicense(c, license.id, body.appId);

  if (!reservationId) {
    throw new HTTPException(409, { message: "Premium activation reservation is not available" });
  }

  await assertPremiumActivationReservationForLicense(c, reservationId, license.id, body.appId);

  let worker: Awaited<ReturnType<typeof callMerlinWorkerThirdPartyToken>>;
  try {
    worker = await callMerlinWorkerThirdPartyToken(c, body.tokenReq);
  } catch (error) {
    await failPremiumActivationReservationForLicense(
      c,
      reservationId,
      license.id,
      body.appId,
      "worker_call",
      getErrorMessage(error),
    );
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: game.name,
      reason: "premium_worker_unreachable",
      metadata: {
        stage: "worker_call",
        activationType: game.activationType,
        reservationId,
        error: getErrorMessage(error),
        httpStatus: getErrorStatus(error),
      },
    });
    throw error;
  }
  if (!worker.ok) {
    await failPremiumActivationReservationForLicense(
      c,
      reservationId,
      license.id,
      body.appId,
      "worker_call",
      worker.error?.upstreamBody || worker.error?.message || "Merlin worker request failed",
    );
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: game.name,
      reason: "premium_token_generation_failed",
      metadata: {
        stage: "worker_call",
        activationType: game.activationType,
        reservationId,
        worker: getPremiumWorkerLogPayload(worker),
      },
    });

    return c.json({
      success: false,
      stage: "worker_call",
      error: worker.error?.message || "Merlin worker request failed",
      worker: {
        status: worker.status,
        ok: worker.ok,
        payload: worker.payload,
        error: worker.error,
      },
    }, 502);
  }

  const payload = worker.payload && typeof worker.payload === "object" && !Array.isArray(worker.payload)
    ? worker.payload as Record<string, unknown>
    : null;
  const parsed = payload && typeof payload.parsed === "object" && payload.parsed !== null && !Array.isArray(payload.parsed)
    ? payload.parsed as Record<string, unknown>
    : null;
  const activationPayload = typeof payload?.token === "string"
    ? payload.token
    : typeof parsed?.token === "string"
      ? parsed.token
      : null;

  if (!activationPayload) {
    await failPremiumActivationReservationForLicense(
      c,
      reservationId,
      license.id,
      body.appId,
      "worker_payload",
      "Merlin worker did not return an activation payload",
    );
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: game.name,
      reason: "premium_token_payload_missing",
      metadata: {
        stage: "worker_payload",
        activationType: game.activationType,
        reservationId,
        worker: getPremiumWorkerLogPayload(worker),
      },
    });

    return c.json({
      success: false,
      stage: "worker_payload",
      error: "Merlin worker did not return an activation payload",
      worker: {
        status: worker.status,
        ok: worker.ok,
        payload: worker.payload,
      },
    }, 502);
  }

  let completion: Awaited<ReturnType<typeof completePremiumActivationForLicense>>;
  try {
    completion = await completePremiumActivationForLicense(
      c,
      reservationId,
      license.id,
      body.appId,
    );
  } catch (error) {
    await writePremiumActivityLog(c, license, {
      action: "premium_activation_failed",
      status: "denied",
      appId: body.appId,
      gameName: game.name,
      reason: "premium_completion_failed",
      metadata: {
        stage: "completion",
        activationType: game.activationType,
        reservationId,
        error: getErrorMessage(error),
        tokenGenerated: true,
      },
    });
    throw error;
  }
  await writePremiumActivityLog(c, license, {
    action: "premium_activation_success",
    status: "success",
    appId: body.appId,
    gameName: game.name,
    metadata: {
      stage: "completed",
      activationType: game.activationType,
      reservationId,
      archiveKey: game.archiveKey,
      cooldownUntil: completion.cooldownUntil,
    },
  });

  return c.json({
    success: true,
    appId: body.appId,
    reservationId,
    cooldownUntil: completion.cooldownUntil,
    activation: {
      appId: body.appId,
      activationPayload,
    },
  }, 200);
});

app.post("/api/premium/activation-events", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const body = parseBody(premiumActivationEventSchema, await c.req.json());
  const game = await getPremiumGame(c, body.appId);

  if (body.reservationId && body.cooldownApplied !== true) {
    await failPremiumActivationReservationForLicense(
      c,
      body.reservationId,
      license.id,
      body.appId,
      body.stage,
      body.message || body.reason || null,
    );
  }

  await writePremiumActivityLog(c, license, {
    action: "premium_activation_failed",
    status: "denied",
    appId: body.appId,
    gameName: game?.name || null,
    reason: body.reason || "premium_local_failure",
    metadata: {
      stage: body.stage,
      activationType: body.activationType || game?.activationType || null,
      reservationId: body.reservationId || null,
      cooldownApplied: body.cooldownApplied === true,
      message: body.message || null,
    },
  });

  return c.json({ success: true }, 200);
});

app.get("/api/premium/download", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const query = parseBody(activationDownloadQuerySchema, c.req.query());
  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS is not configured" });
  }

  const game = await assertPremiumDownloadAccess(c, license.id, query.appid);
  const object = await c.env.MERLIN_ACTIVATIONS.get(game.archiveKey);
  if (!object) {
    throw new HTTPException(404, { message: "Premium activation archive not found" });
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  } else {
    headers.set("Content-Type", "application/zip");
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="${query.appid}.zip"`);
  headers.set("x-merlin-activation-source", "r2-premium");

  return new Response(object.body, {
    status: 200,
    headers,
  });
});

app.get("/api/polls/active", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const polls = await listActivePolls(c, license.id);
  return c.json({ success: true, polls }, 200);
});

app.post("/api/polls/:id/vote", async (c) => {
  const license = await requireAuthenticatedPremiumLicense(c);
  const body = parseBody(pollVoteSchema, await c.req.json());
  const poll = await votePoll(c, c.req.param("id"), license.id, body);
  return c.json({ success: true, poll }, 200);
});

app.post("/api/activations/generate", async (c) => {
  try {
    requireInternalAdminSecret(c);

    const body = parseBody(activationGenerateSchema, await c.req.json());
    const steamAccountId = body.steamAccountId || String(c.env.STEAM_ACCOUNT_ID || "").trim();
    if (!steamAccountId) {
      return c.json({
        success: false,
        stage: "config",
        error: "STEAM_ACCOUNT_ID is not configured",
      }, 500);
    }

    const worker = await callMerlinWorker(c, body.appId, steamAccountId);
    if (!worker.ok) {
      return c.json({
        success: false,
        stage: "worker_call",
        error: worker.error?.message || "Merlin worker request failed",
        worker,
      }, 502);
    }

    const assetKey = getActivationAssetKey(body.appId);
    const asset = c.env.MERLIN_ACTIVATIONS
      ? await c.env.MERLIN_ACTIVATIONS.head(assetKey)
      : null;
    const activation = getActivationPayload(worker, body.appId, steamAccountId, c);

    return c.json({
      success: true,
      appId: body.appId,
      steamAccountId,
      activation,
      worker,
      activationAsset: {
        bucketBound: Boolean(c.env.MERLIN_ACTIVATIONS),
        key: assetKey,
        exists: Boolean(asset),
        size: asset?.size || 0,
        etag: asset?.etag || null,
        uploaded: asset?.uploaded ? asset.uploaded.toISOString() : null,
      },
    }, 200);
  } catch (error) {
    return c.json({
      success: false,
      stage: "unhandled",
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? String(error.stack || "") : null,
    }, 500);
  }
});

app.get("/api/activations/download", async (c) => {
  requireInternalAdminSecret(c);

  const query = parseBody(activationDownloadQuerySchema, c.req.query());
  if (!c.env.MERLIN_ACTIVATIONS) {
    throw new HTTPException(500, { message: "MERLIN_ACTIVATIONS is not configured" });
  }

  const assetKey = getActivationAssetKey(query.appid);
  const object = await c.env.MERLIN_ACTIVATIONS.get(assetKey);
  if (!object) {
    throw new HTTPException(404, { message: "Activation archive not found" });
  }

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  } else {
    headers.set("Content-Type", "application/zip");
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="${query.appid}.zip"`);
  headers.set("x-merlin-activation-source", "r2-activation");

  return new Response(object.body, {
    status: 200,
    headers,
  });
});

openapi.get("/api/health", HealthRoute);
openapi.get("/api/version", VersionRoute);
openapi.post("/api/games/search", GamesSearchRoute);
app.get("/api/manifests/status", async (c) => {
  await requireLauncherLicense(c);

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

app.post("/api/launcher/billing-portal", async (c) => {
  const license = await requireLauncherLicense(c);
  const result = await createLauncherBillingPortalSession(c, license.id);
  return c.json({ success: true, ...result }, 200);
});

openapi.get("/api/manifests", ManifestsRoute);
openapi.get("/api/fixes/catalog", FixesCatalogRoute);
openapi.get("/api/fixes/download", FixesDownloadRoute);
openapi.post("/api/fixes/vote", FixesVoteRoute);
openapi.post("/api/auth/login", LoginRoute);
openapi.post("/api/public/email-verification/start", PublicEmailVerificationStartRoute);
openapi.post("/api/public/email-verification/verify", PublicEmailVerificationVerifyRoute);

app.onError((error, c) => {
  const status = getErrorStatus(error);
  if (error instanceof HTTPException || status) {
    const errorStatus = status || (error as HTTPException).status;
    const message = error instanceof Error ? error.message : "Request failed";
    const logPayload = {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: errorStatus,
      message,
    };
    if (errorStatus >= 500) {
      console.error("[merlin-api:error]", logPayload, error);
    } else {
      console.warn("[merlin-api:client-error]", logPayload);
    }
    return c.json({ success: false, error: message }, errorStatus as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503);
  }

  console.error("[merlin-api:error]", error);
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
