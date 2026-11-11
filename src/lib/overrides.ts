import { HTTPException } from "hono/http-exception";

export type ManifestOverrideConfig = {
	enabled: boolean;
	file: string;
};

export type FixOverrideConfig = {
	enabled: boolean;
	file: string;
	gameName?: string;
	filename?: string;
	size?: string;
};

export type OverrideEntry = {
	migrated?: boolean;
	addedAt?: string;
	name?: string;
	coverUrl?: string;
	adminNote?: string;
	specialCorrectionEnabled?: boolean;
	hidden?: boolean;
	manifestOverride?: ManifestOverrideConfig;
	fixOverride?: FixOverrideConfig;
};

export type OverridesDocument = Record<string, OverrideEntry>;

type OverridesEnv = {
	MERLIN_FILES?: R2Bucket;
	ENVIRONMENT?: string;
};

const OVERRIDES_KEY = "overrides.json";
const REQUIRED_FILES_MESSAGE =
	"Could not prepare the required game files. Please try again later.";
const REQUIRED_CORRECTION_MESSAGE =
	"Could not load this correction right now. Please try again later.";

function requireBucket(env: OverridesEnv): R2Bucket {
	if (!env.MERLIN_FILES) {
		throw new HTTPException(500, { message: "MERLIN_FILES binding is not configured" });
	}

	return env.MERLIN_FILES;
}

function normalizeAppId(appId: string): string {
	const normalized = appId.trim();
	if (!/^\d+$/.test(normalized)) {
		throw new HTTPException(400, { message: "Invalid appId" });
	}

	return normalized;
}

function basename(file: string): string {
	const normalized = file.split("/").filter(Boolean);
	return normalized[normalized.length - 1] || file;
}

function assertSafePath(file: string) {
	if (file.includes("..") || file.includes("\\")) {
		throw new HTTPException(400, { message: "Invalid override file path" });
	}
	if (file.startsWith("/") || file.startsWith("./")) {
		throw new HTTPException(400, { message: "Invalid override file path" });
	}
}

function validateManifestOverride(appId: string, override: ManifestOverrideConfig) {
	assertSafePath(override.file);

	if (!override.file.endsWith(".zip")) {
		throw new HTTPException(400, { message: "Manifest override must be a ZIP file" });
	}

	const expectedPrefix = `${appId}/manifests/`;
	if (!override.file.startsWith(expectedPrefix)) {
		throw new HTTPException(400, { message: "Manifest override path is invalid" });
	}
}

function validateFixOverride(appId: string, override: FixOverrideConfig) {
	assertSafePath(override.file);

	if (!override.file.endsWith(".zip") && !override.file.endsWith(".rar")) {
		throw new HTTPException(400, { message: "Fix override must be a ZIP or RAR file" });
	}

	const expectedPrefix = `${appId}/fixes/`;
	if (!override.file.startsWith(expectedPrefix)) {
		throw new HTTPException(400, { message: "Fix override path is invalid" });
	}
	if (override.gameName !== undefined && !override.gameName.trim()) {
		throw new HTTPException(400, { message: "Fix override gameName is invalid" });
	}
	if (override.filename !== undefined && !override.filename.trim()) {
		throw new HTTPException(400, { message: "Fix override filename is invalid" });
	}
	if (override.size !== undefined && !override.size.trim()) {
		throw new HTTPException(400, { message: "Fix override size is invalid" });
	}
}

function normalizeOverrideName(entry: OverrideEntry): string | undefined {
	const rawName =
		typeof entry.name === "string" && entry.name.trim()
			? entry.name.trim()
			: typeof entry.fixOverride?.gameName === "string" && entry.fixOverride.gameName.trim()
				? entry.fixOverride.gameName.trim()
				: undefined;

	return rawName || undefined;
}

function normalizeAddedAt(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	return Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) ? undefined : value;
}

function normalizeCoverUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:") throw new Error("unsupported protocol");
		return url.toString();
	} catch {
		throw new HTTPException(400, { message: "Override cover URL is invalid" });
	}
}

function validateEntry(
	appId: string,
	entry: OverrideEntry,
	options: { allowLegacyNameMissing?: boolean } = {},
): OverrideEntry {
	const nextEntry: OverrideEntry = {};
	if (entry.migrated === true) nextEntry.migrated = true;
	const normalizedName = normalizeOverrideName(entry);
	const legacyAdminNote =
		typeof (entry.fixOverride as FixOverrideConfig & { adminNote?: string } | undefined)?.adminNote === "string" &&
		(entry.fixOverride as FixOverrideConfig & { adminNote?: string }).adminNote?.trim()
			? (entry.fixOverride as FixOverrideConfig & { adminNote?: string }).adminNote?.trim()
			: undefined;
	const normalizedAdminNote =
		typeof entry.adminNote === "string" && entry.adminNote.trim() ? entry.adminNote.trim() : legacyAdminNote;
	const addedAt = normalizeAddedAt(entry.addedAt);
	const coverUrl = normalizeCoverUrl(entry.coverUrl);

	if (!normalizedName && !options.allowLegacyNameMissing) {
		throw new HTTPException(400, { message: "Override name is required" });
	}

	if (normalizedName) {
		nextEntry.name = normalizedName;
	}
	if (coverUrl) {
		nextEntry.coverUrl = coverUrl;
	}
	if (addedAt) {
		nextEntry.addedAt = addedAt;
	}

	if (normalizedAdminNote) {
		nextEntry.adminNote = normalizedAdminNote;
	}
	if (appId === "4407750" && entry.specialCorrectionEnabled !== undefined) {
		nextEntry.specialCorrectionEnabled = entry.specialCorrectionEnabled === true;
	}

	if (entry.hidden !== undefined) {
		nextEntry.hidden = Boolean(entry.hidden);
	}

	if (entry.manifestOverride) {
		validateManifestOverride(appId, entry.manifestOverride);
		nextEntry.manifestOverride = {
			enabled: Boolean(entry.manifestOverride.enabled),
			file: entry.manifestOverride.file.trim(),
		};
	}

	if (entry.fixOverride) {
		validateFixOverride(appId, entry.fixOverride);
		nextEntry.fixOverride = {
			enabled: Boolean(entry.fixOverride.enabled),
			file: entry.fixOverride.file.trim(),
			gameName: entry.fixOverride.gameName?.trim() || undefined,
			filename: entry.fixOverride.filename?.trim() || basename(entry.fixOverride.file.trim()),
			size: entry.fixOverride.size?.trim() || undefined,
		};
	}

	if (!nextEntry.manifestOverride && !nextEntry.fixOverride && !nextEntry.adminNote && !nextEntry.coverUrl && nextEntry.hidden !== true) {
		throw new HTTPException(400, { message: "At least one override detail must be provided" });
	}

	return nextEntry;
}

export function isZipHeader(bytes: Uint8Array): boolean {
	const [byte0, byte1, byte2, byte3] = bytes;
	return (
		bytes.length >= 4 &&
		byte0 === 0x50 &&
		byte1 === 0x4b &&
		byte2 !== undefined &&
		byte3 !== undefined &&
		((byte2 === 0x03 && byte3 === 0x04) ||
			(byte2 === 0x05 && byte3 === 0x06) ||
			(byte2 === 0x07 && byte3 === 0x08))
	);
}

async function readOverridesSnapshot(env: OverridesEnv): Promise<{ overrides: OverridesDocument; etag: string | null }> {
	const bucket = requireBucket(env);
	const object = await bucket.get(OVERRIDES_KEY);
	if (!object) return { overrides: {}, etag: null };

	let parsed: unknown;
	try {
		parsed = JSON.parse(await object.text());
	} catch {
		throw new HTTPException(500, { message: "Invalid overrides configuration" });
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HTTPException(500, { message: "Invalid overrides configuration" });
	}

	const result: OverridesDocument = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!/^\d+$/.test(key)) {
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}

		const entry = validateEntry(key, value as OverrideEntry, { allowLegacyNameMissing: true });
		result[key] = entry;
	}

	return { overrides: result, etag: object.etag };
}

export async function readOverrides(env: OverridesEnv): Promise<OverridesDocument> {
	const primary = (await readOverridesSnapshot(env)).overrides;
	if (env.ENVIRONMENT !== 'staging') return primary;
	const staged = (await readOverridesSnapshot(stagingImportOverridesEnv(env))).overrides;
	const result = { ...primary };
	for (const [id, entry] of Object.entries(staged)) {
		if (id === "4407750") { result[id] = entry; continue; }
		if (primary[id]?.hidden || primary[id]?.fixOverride) continue;
		result[id] = { ...primary[id], ...entry, ...(primary[id]?.manifestOverride ? { manifestOverride: primary[id]!.manifestOverride } : {}) };
	}
	return result;
}

export function stagingImportOverridesEnv(env: OverridesEnv): OverridesEnv {
	const bucket = requireBucket(env);
	const key = (value: string) => value === OVERRIDES_KEY ? '_fix-import/staging/overrides.json' : value;
	return { MERLIN_FILES: {
		get: (value: string) => bucket.get(key(value)),
		put: (value: string, body: string, options: R2PutOptions) => bucket.put(key(value), body, options),
	} as unknown as R2Bucket };
}

async function overrideEditEnv(env: OverridesEnv, appId: string): Promise<OverridesEnv> {
	if (env.ENVIRONMENT !== 'staging') return env;
	const staged = stagingImportOverridesEnv(env);
	if (appId === "4407750") return staged;
	// A production fix may have been added after this test import. Editing the
	// imported entry must still target the test document, never the primary one.
	return (await readOverridesSnapshot(staged)).overrides[appId] ? staged : env;
}

async function updateOverrides<T>(env: OverridesEnv, update: (overrides: OverridesDocument) => { value: T; changed: boolean }): Promise<T> {
	const bucket = requireBucket(env);
	for (let attempt = 0; attempt < 8; attempt++) {
		const { overrides, etag } = await readOverridesSnapshot(env);
		const result = update(overrides);
		if (!result.changed) return result.value;
		try {
			const saved = await bucket.put(OVERRIDES_KEY, JSON.stringify(overrides, null, 2), {
				onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
				httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
			});
			if (saved) return result.value;
		} catch (error) {
			const message = error instanceof Error ? error.message : '';
			const status = Number((error as {status?:number;statusCode?:number}).status || (error as {statusCode?:number}).statusCode);
			if (![412,429,503].includes(status) && !/\b429\b|\b503\b|too many|SlowDown/i.test(message)) throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 1100 + attempt * 100));
	}
	throw new HTTPException(409, { message: 'Overrides changed concurrently. Please try again.' });
}

export async function writeOverrides(env: OverridesEnv, overrides: OverridesDocument): Promise<void> {
	const bucket = requireBucket(env);
	await bucket.put(OVERRIDES_KEY, JSON.stringify(overrides, null, 2), {
		httpMetadata: {
			contentType: "application/json; charset=utf-8",
			cacheControl: "no-store",
		},
	});
}

export async function upsertOverride(
	env: OverridesEnv,
	appId: string,
	entry: OverrideEntry,
): Promise<OverrideEntry> {
	const normalizedAppId = normalizeAppId(appId);
	// Saving through the normal editor acknowledges review of an imported fix.
	const nextEntry = validateEntry(normalizedAppId, { ...entry, migrated: undefined });
	return updateOverrides(await overrideEditEnv(env, normalizedAppId), overrides => {
		const value = { ...nextEntry, addedAt: nextEntry.addedAt || overrides[normalizedAppId]?.addedAt || new Date().toISOString().slice(0, 10) };
		overrides[normalizedAppId] = value;
		return { value, changed: true };
	});
}

export async function deleteOverride(env: OverridesEnv, appId: string): Promise<boolean> {
	const normalizedAppId = normalizeAppId(appId);
	return updateOverrides(await overrideEditEnv(env, normalizedAppId), overrides => {
		if (!overrides[normalizedAppId]) return { value: false, changed: false };
		delete overrides[normalizedAppId];
		return { value: true, changed: true };
	});
}

// Import only fills an empty fix slot. Recheck inside the conditional write so
// an administrator hiding or editing a game while a download runs wins.
export async function importFixOverride(env: OverridesEnv, appId: string, name: string, fix: FixOverrideConfig, baseEntry?: OverrideEntry): Promise<'imported' | 'hidden' | 'existing'> {
	const id = normalizeAppId(appId);
	return updateOverrides(env, overrides => {
		const current = overrides[id] || baseEntry;
		if (current?.hidden) return { value: 'hidden' as const, changed: false };
		if (current?.fixOverride) return { value: 'existing' as const, changed: false };
		const entry = validateEntry(id, { ...current, name: current?.name || name, fixOverride: fix, migrated: true });
		entry.addedAt = current?.addedAt || new Date().toISOString().slice(0, 10);
		overrides[id] = entry;
		return { value: 'imported' as const, changed: true };
	});
}

export async function getRequiredManifestOverride(
	env: OverridesEnv,
	appId: string,
): Promise<{ bytes: Uint8Array; file: string } | null> {
	const normalizedAppId = normalizeAppId(appId);
	const overrides = await readOverrides(env);
	const entry = overrides[normalizedAppId];
	const manifestOverride = entry?.manifestOverride;

	if (!manifestOverride?.enabled) {
		return null;
	}

	validateManifestOverride(normalizedAppId, manifestOverride);
	const bucket = requireBucket(env);
	const object = await bucket.get(manifestOverride.file);
	if (!object) {
		console.error("[overrides] required manifest override file was not found", {
			appId: normalizedAppId,
			file: manifestOverride.file,
		});
		throw new HTTPException(502, {
			message: REQUIRED_FILES_MESSAGE,
		});
	}

	const bytes = new Uint8Array(await object.arrayBuffer());
	if (!isZipHeader(bytes)) {
		console.error("[overrides] required manifest override file is not a valid ZIP", {
			appId: normalizedAppId,
			file: manifestOverride.file,
		});
		throw new HTTPException(502, {
			message: REQUIRED_FILES_MESSAGE,
		});
	}

	return {
		bytes,
		file: manifestOverride.file,
	};
}

export async function getFixOverrideFile(
	env: OverridesEnv,
	appId: string,
): Promise<{ object: R2ObjectBody; file: string; filename: string; size?: string; gameName?: string } | null> {
	const normalizedAppId = normalizeAppId(appId);
	const overrides = await readOverrides(env);
	const entry = overrides[normalizedAppId];
	const fixOverride = entry?.fixOverride;

	if (!fixOverride?.enabled) {
		return null;
	}

	validateFixOverride(normalizedAppId, fixOverride);
	const bucket = requireBucket(env);
	const object = await bucket.get(fixOverride.file);
	if (!object) {
		console.error("[overrides] required fix override file was not found", {
			appId: normalizedAppId,
			file: fixOverride.file,
		});
		throw new HTTPException(502, {
			message: REQUIRED_CORRECTION_MESSAGE,
		});
	}

	return {
		object,
		file: fixOverride.file,
		filename: fixOverride.filename || basename(fixOverride.file),
		size: fixOverride.size,
		gameName: entry?.name || fixOverride.gameName,
	};
}
