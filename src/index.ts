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
  resetTestLicenseUsage,
  revokeLicense,
  reactivateLicense,
  updateTestLicense,
  updateLicense,
} from "./lib/admin-license-service";
import { getBillingSettings, refreshBillingPriceSnapshots, updateBillingSettings } from "./lib/billing-settings";
import { runBillingNotificationCron } from "./lib/billing-notifications";
import { createLauncherBillingPortalSession, createPublicBillingPortalSession } from "./lib/billing-portal";
import { listAdminPaymentLogs } from "./lib/admin-payment-service";
import { deleteOverride, readOverrides, upsertOverride } from "./lib/overrides";
import {
  cancelPublicAccessPlanChange,
  cancelPublicAccessPlanChangeForLicense,
  createPublicAccessBillingPortal,
  createPublicAccessBillingPortalForLicense,
  createPublicAccessPlanChange,
  createPublicAccessPlanChangeForLicense,
  createPublicAccessUpgradeCheckout,
  getPublicAccessDetails,
  getPublicAccessDetailsForLicense,
  getPublicAccessUpgradeStatus,
  previewPublicAccessPlanChange,
  previewPublicAccessPlanChangeForLicense,
  validatePublicAccessCredentials,
} from "./lib/public-access-management";
import {
  createPublicAccessSession,
  requirePublicAccessSession,
  revokePublicAccessSession,
} from "./lib/public-access-session";
import { createPublicStripeCheckout } from "./lib/public-checkout";
import {
  cancelScheduledSubscriptionPlanChange,
  createSubscriptionPlanChange,
  listBillingPlanPrices,
  listPublicBillingPlanPrices,
  previewSubscriptionPlanChange,
  refreshBillingPlanPrices,
  upsertBillingPlanPrices,
} from "./lib/subscription-plan-change";
import {
  createPublicPixOrder,
  getPublicPixOrderStatus,
  isMercadoPagoPixAvailable,
  parseAndVerifyMercadoPagoWebhook,
  processMercadoPagoWebhookEvent,
} from "./lib/mercadopago-pix";
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
  getPollResults,
  listActivePolls,
  listPolls,
  setPollStatus,
  updatePoll,
  votePoll,
} from "./lib/polls";
import { listBlockedIps, unblockBlockedIp } from "./lib/admin-blocked-ip-service";
import { listUserActivityLogs, writeUserActivityLog } from "./lib/user-activity-service";
import { enforcePublicAccessCredentialsRateLimit, enforcePublicAccessKeyRateLimit } from "./lib/rate-limit";
import { assertRecentPublicEmailVerification } from "./lib/email-verification";
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
import {
  createPublicFeedbackImage,
  deletePublicFeedbackImage,
  getPublicFeedbackImageObject,
  listPublicFeedbackImages,
  updatePublicFeedbackImage,
} from "./lib/public-feedbacks";
import {
  createAnnouncement,
  deleteAnnouncement,
  dismissAnnouncementForever,
  getAnnouncementImageObject,
  getEligibleAnnouncement,
  listAnnouncements,
  recordAnnouncementView,
  updateAnnouncement,
} from "./lib/announcements";
import {
  createPublicPartner,
  deletePublicPartner,
  getPublicPartnerImageObject,
  listPublicPartners,
  updatePublicPartner,
} from "./lib/public-partners";

const app = new Hono<{ Bindings: AppBindings }>();

app.use("*", async (c, next) => {
  await next();

  const isSwaggerRoute = c.req.path === "/doc" || c.req.path.startsWith("/doc/") || c.req.path.startsWith("/openapi.json");
  const csp = isSwaggerRoute
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https://fastly.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    : "default-src 'self'; script-src 'self' https://www.mercadopago.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

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

const pageRoutes = ["/overview", "/licenses", "/activity", "/audit", "/overrides", "/premium", "/polls", "/payments", "/settings", "/public-signup", "/public-feedbacks", "/announcements", "/partners"] as const;
const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});
const recoverySecretSchema = z.string().trim().refine(isValidRecoverySecret, {
  message: "Use 4 a 8 caracteres, sem espacos.",
});
const planTierSchema = z.enum(["bronze", "prata", "ouro"]);
const billingPlanPeriodSchema = z.enum(["monthly", "annual"]);
const billingPlanPaymentMethodSchema = z.enum(["card", "pix"]);
const subscriptionPlanChangeSchema = z.object({
  targetTier: planTierSchema,
  targetPeriod: billingPlanPeriodSchema,
});
const billingPlanPriceUpsertSchema = z.object({
  prices: z.array(z.object({
    paymentMethod: billingPlanPaymentMethodSchema,
    planTier: planTierSchema,
    billingPeriod: billingPlanPeriodSchema,
    priceId: z.string().trim().optional().nullable(),
    amountCents: z.number().int().min(0).optional().nullable(),
    currency: z.string().trim().min(3).max(3).optional().default("brl"),
    active: z.boolean().optional().default(true),
  })).max(24),
});
const updateLicenseSchema = z.object({
  name: z.string().min(1),
  contact: z.string().min(1).optional(),
  contactType: z.enum(["phone", "email", "discord"]).optional().default("phone"),
  phone: z.string().min(1).optional(),
  recoveryPin: recoverySecretSchema.optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hwid: z.string().trim().optional().nullable(),
  planTier: planTierSchema.nullable().optional(),
}).refine((value) => Boolean(value.contact || value.phone), {
  message: "Contact is required",
  path: ["contact"],
});
const updateTestLicenseSchema = z.object({
  name: z.string().trim().min(1),
  normalActivationLimit: z.number().int().min(0).max(9999),
  premiumActivationLimit: z.number().int().min(0).max(9999),
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

async function handleMercadoPagoWebhook(c: AppContext) {
  const rawBody = await c.req.text();
  const event = await parseAndVerifyMercadoPagoWebhook(c, rawBody);
  const result = await processMercadoPagoWebhookEvent(c, event);
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
    plansEnabled: z.boolean().optional().default(false),
    monthlyEnabled: z.boolean(),
    annualEnabled: z.boolean().optional().default(false),
    lifetimeEnabled: z.boolean(),
    pixEnabled: z.boolean().optional().default(false),
    pixMonthlyEnabled: z.boolean().optional().default(true),
    pixAnnualEnabled: z.boolean().optional().default(true),
    pixLifetimeEnabled: z.boolean().optional().default(true),
    monthlyCardTrialEnabled: z.boolean().optional().default(false),
    monthlyCardTrialDays: z.number().int().min(1).max(730).optional().default(30),
    stagingEmailDeliveryEnabled: z.boolean().optional().default(false),
    premiumCatalogCutoffAt: z.string().datetime().nullable().optional(),
    monthlyPriceId: z.string().trim().optional().default(""),
    annualPriceId: z.string().trim().optional().default(""),
    lifetimePriceId: z.string().trim().optional().default(""),
    pixAnnualPriceId: z.string().trim().optional().default(""),
    pixLifetimePriceId: z.string().trim().optional().default(""),
  }).optional(),
});
const publicCheckoutSchema = z.object({
  name: z.string().trim().min(1),
  contact: z.string().trim().email(),
  recoveryPin: recoverySecretSchema,
  acceptedRecoveryNotice: z.boolean(),
  planType: z.enum(["monthly", "annual", "lifetime"]),
  planTier: planTierSchema.optional().nullable(),
});
const publicPixOrderSchema = publicCheckoutSchema.extend({
  mercadoPagoDeviceId: z.string().trim().max(200).optional(),
});
const publicPixOrderStatusParamsSchema = z.object({
  paymentIntentId: z.string().trim().min(1),
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
const publicAccessSessionSchema = publicAccessMeSchema.extend({
  rememberDevice: z.boolean().optional().default(false),
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
  activationCooldownHours: z.number().int().min(24).nullable().optional(),
  accessBronzeEnabled: z.boolean().optional(),
  accessPrataEnabled: z.boolean().optional(),
  accessOuroEnabled: z.boolean().optional(),
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
  activationCooldownHours: z.number().int().min(24).nullable().optional(),
  accessBronzeEnabled: z.boolean().optional(),
  accessPrataEnabled: z.boolean().optional(),
  accessOuroEnabled: z.boolean().optional(),
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
const publicFeedbackUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
});
const announcementBodySchema = z.object({
  internalName: z.string().trim().min(1).max(140),
  title: z.string().trim().min(1).max(180),
  bodyText: z.string().trim().min(1).max(3000),
  active: z.boolean().optional().default(false),
  startsAt: z.string().trim().nullable().optional(),
  endsAt: z.string().trim().nullable().optional(),
  frequency: z.enum(["always", "once_per_day", "once"]).optional().default("always"),
  allowDismissForever: z.boolean().optional().default(false),
  removeImage: z.boolean().optional().default(false),
  imageFit: z.enum(["cover", "contain"]).optional().default("cover"),
  imagePositionX: z.coerce.number().int().min(0).max(100).optional().default(50),
  imagePositionY: z.coerce.number().int().min(0).max(100).optional().default(50),
  imageCropX: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropY: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropWidth: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropHeight: z.coerce.number().min(0).max(100).nullable().optional(),
});
const publicPartnerBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  youtubeUrl: z.string().trim().nullable().optional(),
  tiktokUrl: z.string().trim().nullable().optional(),
  twitchUrl: z.string().trim().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional().default(0),
  active: z.boolean().optional().default(true),
  removeImage: z.boolean().optional().default(false),
  imageCropX: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropY: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropWidth: z.coerce.number().min(0).max(100).nullable().optional(),
  imageCropHeight: z.coerce.number().min(0).max(100).nullable().optional(),
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

async function serveDownloadApp(c: any) {
  const response = await c.env.ASSETS.fetch(new Request(new URL("/download-assets/index.html", c.req.url).toString(), { method: "GET" }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveNoStoreAsset(c: any, pathname: string) {
  const response = await c.env.ASSETS.fetch(new Request(new URL(pathname, c.req.url).toString(), { method: "GET" }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isPagePreviewCrawler(c: any) {
  const cf = c.req.raw.cf as { verifiedBotCategory?: string } | undefined;
  const userAgent = String(c.req.header("user-agent") || "").toLowerCase();
  return cf?.verifiedBotCategory === "Page Preview"
    || userAgent.includes("facebookexternalhit")
    || userAgent.includes("facebot");
}

function serveRootPagePreview(c: any) {
  const origin = new URL(c.req.url).origin;
  const downloadUrl = `${origin}/download`;
  const title = "Merlin - Seu próximo jogo começa aqui";
  const description = "Acesse uma biblioteca com grandes jogos e lançamentos através do launcher do Merlin.";
  const imageUrl = `${origin}/download-assets/social/merlin-og-symbol.png`;
  const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${downloadUrl}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${downloadUrl}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:alt" content="Merlin">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${imageUrl}">
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${description}</p>
      <p><a href="${downloadUrl}">Abrir o Merlin</a></p>
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
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

function formBoolean(value: unknown, fallback = false) {
  if (value === null || value === undefined) return fallback;
  return String(value) === "true" || String(value) === "1";
}

function formNullableString(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function parseAnnouncementForm(formData: FormData) {
  return parseBody(announcementBodySchema, {
    internalName: String(formData.get("internalName") || ""),
    title: String(formData.get("title") || ""),
    bodyText: String(formData.get("bodyText") || ""),
    active: formBoolean(formData.get("active")),
    startsAt: formNullableString(formData.get("startsAt")),
    endsAt: formNullableString(formData.get("endsAt")),
    frequency: String(formData.get("frequency") || "always"),
    allowDismissForever: formBoolean(formData.get("allowDismissForever")),
    removeImage: formBoolean(formData.get("removeImage")),
    imageFit: String(formData.get("imageFit") || "cover"),
    imagePositionX: String(formData.get("imagePositionX") || "50"),
    imagePositionY: String(formData.get("imagePositionY") || "50"),
    imageCropX: formNullableString(formData.get("imageCropX")),
    imageCropY: formNullableString(formData.get("imageCropY")),
    imageCropWidth: formNullableString(formData.get("imageCropWidth")),
    imageCropHeight: formNullableString(formData.get("imageCropHeight")),
  });
}

function parsePublicPartnerForm(formData: FormData) {
  return parseBody(publicPartnerBodySchema, {
    name: String(formData.get("name") || ""),
    youtubeUrl: formNullableString(formData.get("youtubeUrl")),
    tiktokUrl: formNullableString(formData.get("tiktokUrl")),
    twitchUrl: formNullableString(formData.get("twitchUrl")),
    sortOrder: String(formData.get("sortOrder") || "0"),
    active: formBoolean(formData.get("active"), true),
    removeImage: formBoolean(formData.get("removeImage")),
    imageCropX: formNullableString(formData.get("imageCropX")),
    imageCropY: formNullableString(formData.get("imageCropY")),
    imageCropWidth: formNullableString(formData.get("imageCropWidth")),
    imageCropHeight: formNullableString(formData.get("imageCropHeight")),
  });
}

function getPublicBillingPayload(c: AppContext, billing: Awaited<ReturnType<typeof getBillingSettings>>) {
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

  const pixRuntimeAvailable = isMercadoPagoPixAvailable(c);
  const pixMonthlyAvailable = pixRuntimeAvailable && billing.pixEnabled && billing.monthlyEnabled && billing.pixMonthlyEnabled;
  const pixAnnualAvailable = pixRuntimeAvailable && billing.pixEnabled && billing.annualEnabled && billing.pixAnnualEnabled;
  const pixLifetimeAvailable = pixRuntimeAvailable && billing.pixEnabled && billing.lifetimeEnabled && billing.pixLifetimeEnabled;

  return {
    billingEnabled: billing.billingEnabled,
    plansEnabled: billing.plansEnabled,
    monthlyEnabled: billing.monthlyEnabled,
    annualEnabled: billing.annualEnabled,
    lifetimeEnabled: billing.lifetimeEnabled,
    monthlyCardTrial: {
      enabled: billing.monthlyCardTrialEnabled,
      days: billing.monthlyCardTrialDays,
    },
    paymentMethods: {
      card: true,
      pix: pixMonthlyAvailable || pixAnnualAvailable || pixLifetimeAvailable,
      pixMonthly: pixMonthlyAvailable,
      pixAnnual: pixAnnualAvailable,
      pixLifetime: pixLifetimeAvailable,
    },
    prices: {
      monthly: mapPrice(billing.prices.monthly),
      annual: mapPrice(billing.prices.annual),
      lifetime: mapPrice(billing.prices.lifetime),
      pixAnnual: mapPrice(billing.prices.pixAnnual),
      pixLifetime: mapPrice(billing.prices.pixLifetime),
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

app.get("/", (c) => {
  if (isPagePreviewCrawler(c)) {
    return serveRootPagePreview(c);
  }
  return c.redirect("/download", 302);
});

app.get("/download", (c) => serveDownloadApp(c));
app.get("/checkout", (c) => {
  const target = new URL(c.req.url);
  target.pathname = "/download";
  return c.redirect(target.toString(), 302);
});
app.get("/download-assets/assets/app.js", (c) => serveNoStoreAsset(c, "/download-assets/assets/app.js"));
app.get("/download-assets/assets/app.css", (c) => serveNoStoreAsset(c, "/download-assets/assets/app.css"));

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

app.get("/panel-api/polls/:id/results", async (c) => {
  await requireAdminSession(c);
  const results = await getPollResults(c, c.req.param("id"));
  return c.json({ success: true, ...results }, 200);
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
    billing: getPublicBillingPayload(c, billing),
  }, 200);
});

app.get("/api/billing/settings-public", async (c) => {
  const settings = await getPublicSignupSettings(c);
  const billing = await getBillingSettings(c);
  return c.json({
    success: true,
    settings: { enabled: settings.enabled },
    billing: getPublicBillingPayload(c, billing),
  }, 200);
});

app.get("/api/billing/plan-prices-public", async (c) => {
  const prices = await listPublicBillingPlanPrices(c);
  return c.json({ success: true, prices }, 200);
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

app.post("/api/public/pix/orders", async (c) => {
  const body = parseBody(publicPixOrderSchema, await c.req.json());
  try {
    const result = await createPublicPixOrder(c, body);
    return c.json({ success: true, ...result }, 201);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error || "Unknown Pix checkout error");
    console.error("[public-pix:error]", { message });
    if (c.env.ENVIRONMENT === "staging") {
      return c.json({ success: false, error: `Pix debug: ${message}` }, 500);
    }
    throw error;
  }
});

app.get("/api/public/pix/orders/:paymentIntentId/status", async (c) => {
  const params = parseBody(publicPixOrderStatusParamsSchema, c.req.param());
  const result = await getPublicPixOrderStatus(c, params.paymentIntentId);
  return c.json({ success: true, ...result }, 200);
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

app.get("/api/public/feedbacks", async (c) => {
  const feedbacks = await listPublicFeedbackImages(c);
  return c.json({ success: true, feedbacks }, 200);
});

app.get("/api/public/feedbacks/:id/image", async (c) => {
  const id = Number(c.req.param("id"));
  const { row, object } = await getPublicFeedbackImageObject(c, id);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", row.content_type);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});

app.get("/api/public/partners", async (c) => {
  const partners = await listPublicPartners(c);
  return c.json({ success: true, partners }, 200);
});

app.get("/api/public/partners/:id/image", async (c) => {
  const { row, object } = await getPublicPartnerImageObject(c, c.req.param("id"));
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", row.image_content_type || "image/jpeg");
  headers.set("cache-control", "public, max-age=3600");
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
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
app.post("/api/webhooks/mercadopago", handleMercadoPagoWebhook);

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

app.post("/panel-api/public-signup/billing/refresh-prices", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const settings = await getPublicSignupSettings(c);
  const billing = await refreshBillingPriceSnapshots(c);
  const prices = billing.plansEnabled
    ? await refreshBillingPlanPrices(c)
    : await listBillingPlanPrices(c);
  const metrics = await getPublicSignupMetrics(c);
  return c.json({ success: true, settings: getPublicSignupSettingsPayload(settings), billing, prices, metrics }, 200);
});

app.get("/panel-api/billing/plan-prices", async (c) => {
  await requireAdminSession(c);
  const prices = await listBillingPlanPrices(c);
  return c.json({ success: true, prices }, 200);
});

app.put("/panel-api/billing/plan-prices", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(billingPlanPriceUpsertSchema, await c.req.json());
  const prices = await upsertBillingPlanPrices(c, body.prices);
  return c.json({ success: true, prices }, 200);
});

app.get("/panel-api/public-feedbacks", async (c) => {
  await requireAdminSession(c);
  const feedbacks = await listPublicFeedbackImages(c, { includeDisabled: true });
  return c.json({ success: true, feedbacks }, 200);
});

app.post("/panel-api/public-feedbacks", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "Selecione uma imagem de feedback." });
  }

  const feedback = await createPublicFeedbackImage(c, file, {
    title: String(formData.get("title") || ""),
    sortOrder: Number(formData.get("sortOrder") || "0"),
    enabled: String(formData.get("enabled") || "true") !== "false",
  });
  return c.json({ success: true, feedback }, 201);
});

app.put("/panel-api/public-feedbacks/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const body = parseBody(publicFeedbackUpdateSchema, await c.req.json());
  const feedback = await updatePublicFeedbackImage(c, Number(c.req.param("id")), body);
  return c.json({ success: true, feedback }, 200);
});

app.delete("/panel-api/public-feedbacks/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const result = await deletePublicFeedbackImage(c, Number(c.req.param("id")));
  return c.json(result, 200);
});

app.get("/panel-api/partners", async (c) => {
  await requireAdminSession(c);
  const partners = await listPublicPartners(c, { includeInactive: true });
  return c.json({ success: true, partners }, 200);
});

app.post("/panel-api/partners", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const formData = await c.req.formData();
  const file = formData.get("file");
  const partner = await createPublicPartner(c, parsePublicPartnerForm(formData), file instanceof File ? file : null);
  return c.json({ success: true, partner }, 201);
});

app.put("/panel-api/partners/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const formData = await c.req.formData();
  const file = formData.get("file");
  const partner = await updatePublicPartner(c, c.req.param("id"), parsePublicPartnerForm(formData), file instanceof File ? file : null);
  return c.json({ success: true, partner }, 200);
});

app.delete("/panel-api/partners/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const result = await deletePublicPartner(c, c.req.param("id"));
  return c.json(result, 200);
});

app.get("/panel-api/announcements", async (c) => {
  await requireAdminSession(c);
  const announcements = await listAnnouncements(c);
  return c.json({ success: true, announcements }, 200);
});

app.post("/panel-api/announcements", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const formData = await c.req.formData();
  const file = formData.get("file");
  const announcement = await createAnnouncement(
    c,
    parseAnnouncementForm(formData),
    file instanceof File ? file : null
  );
  return c.json({ success: true, announcement }, 201);
});

app.put("/panel-api/announcements/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const formData = await c.req.formData();
  const file = formData.get("file");
  const announcement = await updateAnnouncement(
    c,
    c.req.param("id"),
    parseAnnouncementForm(formData),
    file instanceof File ? file : null
  );
  return c.json({ success: true, announcement }, 200);
});

app.delete("/panel-api/announcements/:id", async (c) => {
  await requireAdminSession(c, { mutate: true });
  const result = await deleteAnnouncement(c, c.req.param("id"));
  return c.json(result, 200);
});

app.get("/panel-api/announcements/:id/image", async (c) => {
  await requireAdminSession(c);
  const { object } = await getAnnouncementImageObject(c, c.req.param("id"));
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(object.body, { status: 200, headers });
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

app.put("/panel-api/licenses/:id/test", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const body = parseBody(updateTestLicenseSchema, await c.req.json());
  const updated = await updateTestLicense(c, parseLicenseId(c.req.param("id")), body, {
    adminUserId: session.session.admin_user_id,
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
  });
  return c.json(mapLicense(updated), 200);
});

app.post("/panel-api/licenses/:id/test/reset-usage", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const updated = await resetTestLicenseUsage(c, parseLicenseId(c.req.param("id")), {
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

app.post("/panel-api/licenses/:id/plan-change/preview", async (c) => {
  await requireAdminSession(c);
  const licenseId = parseLicenseId(c.req.param("id"));
  const body = parseBody(subscriptionPlanChangeSchema, await c.req.json());
  const planChange = await previewSubscriptionPlanChange(c, {
    licenseId,
    targetTier: body.targetTier,
    targetPeriod: body.targetPeriod,
  });
  return c.json({ success: true, planChange }, 200);
});

app.post("/panel-api/licenses/:id/plan-change", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const licenseId = parseLicenseId(c.req.param("id"));
  const body = parseBody(subscriptionPlanChangeSchema, await c.req.json());
  const planChange = await createSubscriptionPlanChange(c, {
    licenseId,
    targetTier: body.targetTier,
    targetPeriod: body.targetPeriod,
  });
  await writeAdminAuditLog(c, {
    adminUserId: session.session.admin_user_id,
    action: "license_plan_change_requested",
    entityType: "license",
    entityId: String(licenseId),
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
    metadata: planChange,
  });
  const updated = await getLicense(c, licenseId);
  return c.json({ success: true, planChange, license: mapLicense(updated) }, 201);
});

app.post("/api/public/access/identify", async (c) => {
  const body = parseBody(publicAccessMeSchema, await c.req.json());
  await enforcePublicAccessCredentialsRateLimit(c, body.email);
  await validatePublicAccessCredentials(c, body);
  return c.json({ success: true }, 200);
});

app.post("/api/public/access/session", async (c) => {
  const body = parseBody(publicAccessSessionSchema, await c.req.json());
  await enforcePublicAccessCredentialsRateLimit(c, body.email);
  await assertRecentPublicEmailVerification(c, body.email);
  const { license } = await validatePublicAccessCredentials(c, body);
  const session = await createPublicAccessSession(c, license.id, body.rememberDevice);
  const access = await getPublicAccessDetailsForLicense(c, license.id);
  return c.json({ success: true, ...session, ...access }, 200);
});

app.get("/api/public/access/session", async (c) => {
  const session = await requirePublicAccessSession(c);
  const access = await getPublicAccessDetailsForLicense(c, session.session.license_id);
  return c.json({ success: true, csrfToken: session.csrfToken, ...access }, 200);
});

app.post("/api/public/access/session/logout", async (c) => {
  await requirePublicAccessSession(c, { mutate: true });
  await revokePublicAccessSession(c);
  return c.json({ success: true }, 200);
});

app.post("/api/public/access/session/plan-change/preview", async (c) => {
  const session = await requirePublicAccessSession(c, { mutate: true });
  const body = parseBody(subscriptionPlanChangeSchema, await c.req.json());
  const planChange = await previewPublicAccessPlanChangeForLicense(c, session.session.license_id, body);
  return c.json({ success: true, planChange }, 200);
});

app.post("/api/public/access/session/plan-change", async (c) => {
  const session = await requirePublicAccessSession(c, { mutate: true });
  const body = parseBody(subscriptionPlanChangeSchema, await c.req.json());
  const license = await getLicense(c, session.session.license_id);
  const planChange = await createPublicAccessPlanChangeForLicense(c, license, body, { returnPath: "/meu-acesso" });
  return c.json({ success: true, planChange }, 201);
});

app.post("/api/public/access/session/plan-change/cancel", async (c) => {
  const session = await requirePublicAccessSession(c, { mutate: true });
  const planChange = await cancelPublicAccessPlanChangeForLicense(c, session.session.license_id);
  return c.json({ success: true, planChange }, 200);
});

app.post("/api/public/access/session/billing-portal", async (c) => {
  const session = await requirePublicAccessSession(c, { mutate: true });
  const license = await getLicense(c, session.session.license_id);
  const portal = await createPublicAccessBillingPortalForLicense(c, license, "/meu-acesso?access=portal-return");
  return c.json({ success: true, ...portal }, 200);
});

app.post("/api/public/access/plan-change/preview", async (c) => {
  const body = parseBody(publicAccessMeSchema.merge(subscriptionPlanChangeSchema), await c.req.json());
  const planChange = await previewPublicAccessPlanChange(c, body);
  return c.json({ success: true, planChange }, 200);
});

app.post("/api/public/access/plan-change", async (c) => {
  const body = parseBody(publicAccessMeSchema.merge(subscriptionPlanChangeSchema), await c.req.json());
  const planChange = await createPublicAccessPlanChange(c, body);
  return c.json({ success: true, planChange }, 201);
});

app.post("/api/public/access/plan-change/cancel", async (c) => {
  const body = parseBody(publicAccessMeSchema, await c.req.json());
  const planChange = await cancelPublicAccessPlanChange(c, body);
  return c.json({ success: true, planChange }, 200);
});

app.post("/panel-api/licenses/:id/plan-change/cancel", async (c) => {
  const session = await requireAdminSession(c, { mutate: true });
  const licenseId = parseLicenseId(c.req.param("id"));
  const result = await cancelScheduledSubscriptionPlanChange(c, licenseId);
  await writeAdminAuditLog(c, {
    adminUserId: session.session.admin_user_id,
    action: "license_plan_change_canceled",
    entityType: "license",
    entityId: String(licenseId),
    ipHash: session.session.ip_hash,
    userAgentHash: session.session.user_agent_hash,
    metadata: result,
  });
  return c.json({ success: true, result }, 200);
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

app.get("/api/announcements/eligible", async (c) => {
  const license = await requireLauncherLicense(c);
  const announcement = await getEligibleAnnouncement(c, license.id);
  return c.json({ success: true, announcement }, 200);
});

app.post("/api/announcements/:id/view", async (c) => {
  const license = await requireLauncherLicense(c);
  const result = await recordAnnouncementView(c, c.req.param("id"), license.id);
  return c.json(result, 200);
});

app.post("/api/announcements/:id/dismiss", async (c) => {
  const license = await requireLauncherLicense(c);
  const result = await dismissAnnouncementForever(c, c.req.param("id"), license.id);
  return c.json(result, 200);
});

app.get("/api/announcements/:id/image", async (c) => {
  const { object } = await getAnnouncementImageObject(c, c.req.param("id"));
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(object.body, { status: 200, headers });
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
    const codedError = error as unknown as { code?: unknown };
    const code = typeof codedError.code === "string"
      ? codedError.code
      : undefined;
    return c.json({
      success: false,
      error: message,
      ...(code ? { code } : {}),
    }, errorStatus as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503);
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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AppBindings, _ctx: ExecutionContext) {
    await runBillingNotificationCron(env);
  },
};
