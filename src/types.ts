import type { Context } from "hono";
import { z } from "zod";

export interface AppBindings extends Env {
  SESSION_HASH_SECRET: string;
  ADMIN_API_TOKEN?: string;
  INTERNAL_ADMIN_AUTH_SECRET?: string;
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

export const FixDownloadQuery = z.object({
	appid: z.string().regex(/^\d+$/),
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

export const CreateLicenseRequest = z.object({
	name: z.string().min(1).describe("Customer name"),
	phone: z.string().min(1).describe("Customer phone number"),
	expiresAt: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.describe("License expiration date in YYYY-MM-DD format"),
});

export const LicenseResponse = z.object({
	id: z.number().int().positive(),
	licenseKey: z.string().regex(/^MERLIN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
	name: z.string(),
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

