import type { Context } from "hono";
import { z } from "zod";

export interface AppBindings extends Env {
  SESSION_HASH_SECRET: string;
  RESEND_API_KEY: string;
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

export const LicenseStatus = z.enum(["active", "revoked"]);

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
});

export const PublicEmailVerificationVerifyRequest = z.object({
	email: z.string().trim().email().max(254),
	code: z.string().trim().regex(/^\d{6}$/),
});

export const PublicEmailVerificationVerifyResponse = z.object({
	success: z.literal(true),
	verified: z.literal(true),
});

export const CreateLicenseRequest = z.object({
	name: z.string().min(1).describe("Customer name"),
	contact: z.string().min(1).optional().describe("Customer contact"),
	contactType: z.enum(["phone", "email", "discord"]).optional().default("phone"),
	phone: z.string().min(1).optional().describe("Deprecated alias for contact"),
	expiresAt: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.describe("License expiration date in YYYY-MM-DD format"),
}).refine((value) => Boolean(value.contact || value.phone), {
	message: "Contact is required",
	path: ["contact"],
});

export const LicenseResponse = z.object({
	id: z.number().int().positive(),
	licenseKey: z.string().regex(/^MERLIN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
	name: z.string(),
	contact: z.string(),
	contactType: z.enum(["phone", "email", "discord"]),
	source: z.string(),
	recoveryNoticeAcceptedAt: z.string().nullable().optional(),
	phone: z.string(),
	hwid: z.string().nullable(),
	expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	status: LicenseStatus,
	revokedReason: z.string().nullable(),
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
		manifestOverride: ManifestOverrideConfig.optional(),
		fixOverride: FixOverrideConfig.optional(),
	})
	.refine((value) => Boolean(value.adminNote || value.manifestOverride || value.fixOverride), {
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

