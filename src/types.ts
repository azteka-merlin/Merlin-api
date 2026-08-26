import type { Context } from "hono";
import { z } from "zod";
import { isValidRecoverySecret } from "./lib/recovery-pin";

export interface AppBindings extends Omit<Env, "PIX_ENABLED" | "PIX_PROVIDER" | "PIX_ENV" | "MERCADO_PAGO_API_BASE" | "MERCADO_PAGO_TEST_PAYER_EMAIL" | "STEAM_ACCOUNT_ID"> {
  SESSION_HASH_SECRET: string;
  RESEND_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  STRIPE_ANNUAL_PRICE_ID?: string;
  STRIPE_LIFETIME_PRICE_ID?: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
  PIX_ENABLED?: string;
  PIX_PROVIDER?: string;
  PIX_ENV?: string;
  MERCADO_PAGO_ACCESS_TOKEN?: string;
  MERCADO_PAGO_WEBHOOK_SECRET?: string;
  MERCADO_PAGO_TEST_ACCESS_TOKEN?: string;
  MERCADO_PAGO_TEST_WEBHOOK_SECRET?: string;
  MERCADO_PAGO_TEST_PAYER_EMAIL?: string;
  MERCADO_PAGO_API_BASE?: string;
  EMAIL_FROM?: string;
  ADMIN_API_TOKEN?: string;
  INTERNAL_ADMIN_AUTH_SECRET?: string;
  MERLIN_WORKER_TOKEN?: string;
  STEAM_ACCOUNT_ID?: string;
}

export type AppContext = Context<{ Bindings: AppBindings }>;

export const HealthResponse = z.object({
	status: z.literal("online"),
});

export const VersionResponse = z.object({
	name: z.literal("merlin-api"),
	version: z.string(),
});

export const LicenseStatus = z.enum(["active", "revoked", "expired"]);
export const PlanTier = z.enum(["bronze", "prata", "ouro"]);

export const LoginRequest = z.object({
	licenseKey: z
		.string()
		.regex(/^MERLIN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
		.describe("User license key"),
	hwid: z.string().min(1).describe("Hardware identifier"),
});

export const LoginResponse = z.object({
	success: z.literal(true),
	tokenType: z.literal("Bearer"),
	accessToken: z.string(),
	expiresIn: z.number().int().positive(),
	license: z.object({
		name: z.string(),
		expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		status: LicenseStatus,
		planTier: PlanTier.optional(),
		billing: z.object({
			accessType: z.string(),
			billingStatus: z.string(),
			currentPeriodEnd: z.string().nullable(),
			cancelAtPeriodEnd: z.boolean(),
			canManageSubscription: z.boolean(),
		}).optional(),
	}),
});

export const ManifestQuery = z.object({
	appid: z.string().min(1),
});

export const GameSearchRequest = z.object({
	searchTerm: z.string().min(1),
	limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export const GameSearchItem = z.object({
	appId: z.string().regex(/^\d+$/),
	name: z.string().min(1),
	coverUrl: z.string().url().nullable().optional(),
	coverSource: z.string().min(1).nullable().optional(),
});

export const GameSearchResponse = z.object({
	success: z.literal(true),
	source: z.enum(["depotbox", "catalog"]),
	items: z.array(GameSearchItem),
});

export const FixDownloadQuery = z.object({
	appid: z.string().regex(/^\d+$/),
	source: z.enum(["override", "depotbox", "ryuu"]).optional(),
});

export const CorrectionVoteValue = z.enum(["up", "down"]);

export const CorrectionVoteRequest = z.object({
	appId: z.string().regex(/^\d+$/),
	vote: CorrectionVoteValue,
});

export const CorrectionVoteResponse = z.object({
	success: z.literal(true),
	appId: z.string().regex(/^\d+$/),
	vote: CorrectionVoteValue,
	viewerVote: CorrectionVoteValue,
	upvotes: z.number().int().nonnegative(),
	downvotes: z.number().int().nonnegative(),
	score: z.number().int(),
});

export const PublicEmailVerificationStartRequest = z.object({
	email: z.string().trim().email().max(254),
});

export const PublicEmailVerificationStartResponse = z.object({
	success: z.literal(true),
	cooldownSeconds: z.number().int().positive(),
	expiresIn: z.number().int().positive(),
	deliveryMode: z.enum(["email", "staging_test"]),
});

export const PublicEmailVerificationVerifyRequest = z.object({
	email: z.string().trim().email().max(254),
	code: z.string().trim().regex(/^(?:\d{6}|12345)$/),
});

export const PublicEmailVerificationVerifyResponse = z.object({
	success: z.literal(true),
	verified: z.literal(true),
});

const RecoverySecretRequest = z.string().trim().refine(isValidRecoverySecret, {
	message: "Use 4 a 8 caracteres, sem espacos.",
});

export const CreateLicenseRequest = z.object({
	name: z.string().min(1).describe("Customer name"),
	contact: z.string().min(1).optional().describe("Customer contact"),
	contactType: z.enum(["phone", "email", "discord", "none"]).optional().default("phone"),
	phone: z.string().min(1).optional().describe("Deprecated alias for contact"),
	recoveryPin: RecoverySecretRequest.optional().describe("Optional recovery secret. Use 4 to 8 non-space characters."),
	expiresAt: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("License expiration date in YYYY-MM-DD format"),
	licenseType: z.enum(["normal", "test"]).optional().default("normal"),
	planTier: PlanTier.nullable().optional(),
	normalActivationLimit: z.number().int().min(0).max(9999).optional(),
	premiumActivationLimit: z.number().int().min(0).max(9999).optional(),
}).refine((value) => value.licenseType === "test" || Boolean(value.contact || value.phone), {
	message: "Contact is required",
	path: ["contact"],
}).refine((value) => value.licenseType === "test" || Boolean(value.expiresAt), {
	message: "Expiration date is required",
	path: ["expiresAt"],
}).refine((value) => value.licenseType !== "test" || value.normalActivationLimit !== undefined, {
	message: "Normal activation limit is required",
	path: ["normalActivationLimit"],
}).refine((value) => value.licenseType !== "test" || value.premiumActivationLimit !== undefined, {
	message: "Premium activation limit is required",
	path: ["premiumActivationLimit"],
});

export const LicenseResponse = z.object({
	id: z.number().int().positive(),
	licenseKey: z.string().regex(/^MERLIN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
	name: z.string(),
	contact: z.string(),
	contactType: z.enum(["phone", "email", "discord", "none"]),
	source: z.string(),
	licenseType: z.enum(["normal", "test"]).optional(),
	planTier: PlanTier.nullable().optional(),
	premiumCatalogRestricted: z.boolean().optional(),
	normalActivationLimit: z.number().int().nonnegative().nullable().optional(),
	premiumActivationLimit: z.number().int().nonnegative().nullable().optional(),
	normalActivationUsed: z.number().int().nonnegative().optional(),
	premiumActivationUsed: z.number().int().nonnegative().optional(),
	activationUsageResetAt: z.string().nullable().optional(),
	hasRecoveryPin: z.boolean().optional(),
	recoveryNoticeAcceptedAt: z.string().nullable().optional(),
	phone: z.string(),
	hwid: z.string().nullable(),
	expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	status: LicenseStatus,
	revokedReason: z.string().nullable(),
	revokedOrigin: z.string().nullable().optional(),
	revokedEventId: z.string().nullable().optional(),
	customerId: z.number().int().positive().nullable().optional(),
	accessType: z.string().optional(),
	billingStatus: z.string().optional(),
	stripeCustomerId: z.string().nullable().optional(),
	stripeSubscriptionId: z.string().nullable().optional(),
	stripeCheckoutSessionId: z.string().nullable().optional(),
	billingCurrentPeriodEnd: z.string().nullable().optional(),
	billingCurrentPeriodStart: z.string().nullable().optional(),
	billingCancelAtPeriodEnd: z.boolean().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

export const LicenseParams = z.object({
	id: z.coerce.number().int().positive(),
});

export const LicenseListResponse = z.object({
	licenses: z.array(LicenseResponse),
});

export const RenewLicenseRequest = z.object({
	expiresAt: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.describe("New license expiration date in YYYY-MM-DD format"),
});

export const RevokeLicenseRequest = z.object({
	reason: z.string().min(1).describe("Reason for revocation"),
});

export const ManifestOverrideConfig = z.object({
	enabled: z.boolean(),
	file: z.string().min(1),
});

export const FixOverrideConfig = z.object({
	enabled: z.boolean(),
	file: z.string().min(1),
	gameName: z.string().min(1).optional(),
	filename: z.string().min(1).optional(),
	size: z.string().min(1).optional(),
});

export const OverrideEntry = z.object({
	name: z.string().min(1).optional(),
	adminNote: z.string().min(1).optional(),
	hidden: z.boolean().optional(),
	manifestOverride: ManifestOverrideConfig.optional(),
	fixOverride: FixOverrideConfig.optional(),
});

export const OverrideParams = z.object({
	appId: z.string().regex(/^\d+$/),
});

export const OverrideUpsertRequest = z
	.object({
		appId: z.string().regex(/^\d+$/),
		name: z.string().min(1),
		adminNote: z.string().min(1).optional(),
		hidden: z.boolean().optional(),
		manifestOverride: ManifestOverrideConfig.optional(),
		fixOverride: FixOverrideConfig.optional(),
	})
	.refine((value) => Boolean(value.adminNote || value.hidden === true || value.manifestOverride || value.fixOverride), {
		message: "At least one override detail must be provided",
		path: ["appId"],
	});

export const OverrideResponse = z.object({
	appId: z.string().regex(/^\d+$/),
	override: OverrideEntry,
});

export const OverrideListResponse = z.object({
	overrides: z.record(z.string(), OverrideEntry),
});

export const DeleteOverrideResponse = z.object({
	success: z.literal(true),
	appId: z.string().regex(/^\d+$/),
});

