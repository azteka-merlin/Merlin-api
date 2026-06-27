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
	adminNote?: string;
};

export type OverrideEntry = {
	name?: string;
	manifestOverride?: ManifestOverrideConfig;
	fixOverride?: FixOverrideConfig;
};

export type OverridesDocument = Record<string, OverrideEntry>;

type OverridesEnv = {
	MERLIN_FILES?: R2Bucket;
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
	if (override.adminNote !== undefined && !override.adminNote.trim()) {
		throw new HTTPException(400, { message: "Fix override adminNote is invalid" });
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

function validateEntry(
	appId: string,
	entry: OverrideEntry,
	options: { allowLegacyNameMissing?: boolean } = {},
): OverrideEntry {
	const nextEntry: OverrideEntry = {};
	const normalizedName = normalizeOverrideName(entry);

	if (!normalizedName && !options.allowLegacyNameMissing) {
		throw new HTTPException(400, { message: "Override name is required" });
	}

	if (normalizedName) {
		nextEntry.name = normalizedName;
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
			adminNote: entry.fixOverride.adminNote?.trim() || undefined,
		};
	}

	if (!nextEntry.manifestOverride && !nextEntry.fixOverride) {
		throw new HTTPException(400, { message: "At least one override must be provided" });
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
		[0x03, 0x05, 0x07].includes(byte2) &&
		[0x04, 0x06, 0x08].includes(byte3)
	);
}

export async function readOverrides(env: OverridesEnv): Promise<OverridesDocument> {
	const bucket = requireBucket(env);
	const object = await bucket.get(OVERRIDES_KEY);
	if (!object) return {};

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

	return result;
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
	const overrides = await readOverrides(env);
	const nextEntry = validateEntry(normalizedAppId, entry);
	overrides[normalizedAppId] = nextEntry;
	await writeOverrides(env, overrides);
	return nextEntry;
}

export async function deleteOverride(env: OverridesEnv, appId: string): Promise<boolean> {
	const normalizedAppId = normalizeAppId(appId);
	const overrides = await readOverrides(env);
	if (!overrides[normalizedAppId]) {
		return false;
	}

	delete overrides[normalizedAppId];
	await writeOverrides(env, overrides);
	return true;
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
): Promise<{ bytes: Uint8Array; file: string; filename: string; size?: string; gameName?: string } | null> {
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

	const bytes = new Uint8Array(await object.arrayBuffer());
	return {
		bytes,
		file: fixOverride.file,
		filename: fixOverride.filename || basename(fixOverride.file),
		size: fixOverride.size,
		gameName: entry?.name || fixOverride.gameName,
	};
}
