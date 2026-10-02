import type { AppContext } from "../types";

export const MANIFEST_PRIMARY_SOURCES = ["depotbox", "ryuu", "steam-api"] as const;

export type ManifestPrimarySource = (typeof MANIFEST_PRIMARY_SOURCES)[number];

export const DEFAULT_MANIFEST_PRIMARY_SOURCE: ManifestPrimarySource = "depotbox";

type ManifestSourceSettingsRow = {
  primary_source: string;
  validate_depotbox: number;
  validate_ryuu: number;
  validate_steam_api: number;
  updated_at: string;
};

export type DepotValidationSource = ManifestPrimarySource;

export type ManifestSourceSettingsPatch = {
  primarySource?: ManifestPrimarySource;
  depotValidation?: Partial<Record<DepotValidationSource, boolean>>;
};

function normalizePrimarySource(value: unknown): ManifestPrimarySource {
	return MANIFEST_PRIMARY_SOURCES.includes(value as ManifestPrimarySource)
		? value as ManifestPrimarySource
		: DEFAULT_MANIFEST_PRIMARY_SOURCE;
}

export function manifestPrimarySourceOrder(value: unknown): ManifestPrimarySource[] {
	const primarySource = normalizePrimarySource(value);
	return [primarySource, ...MANIFEST_PRIMARY_SOURCES.filter((source) => source !== primarySource)];
}

export async function getManifestSourceSettings(c: AppContext) {
  const row = await c.env.merlin_db
    .prepare("SELECT primary_source, validate_depotbox, validate_ryuu, validate_steam_api, updated_at FROM manifest_source_settings WHERE id = 1")
    .first<ManifestSourceSettingsRow>();

  return {
    primarySource: normalizePrimarySource(row?.primary_source),
    depotValidation: {
      depotbox: row?.validate_depotbox === 1,
      ryuu: row?.validate_ryuu === 1,
      "steam-api": row?.validate_steam_api === 1,
    },
    updatedAt: row?.updated_at || null,
  };
}

export async function updateManifestSourceSettings(c: AppContext, patch: ManifestSourceSettingsPatch) {
  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (patch.primarySource !== undefined) {
    updates.push("primary_source = ?");
    values.push(patch.primarySource);
  }
  for (const [source, column] of [
    ["depotbox", "validate_depotbox"],
    ["ryuu", "validate_ryuu"],
    ["steam-api", "validate_steam_api"],
  ] as const) {
    const enabled = patch.depotValidation?.[source];
    if (enabled !== undefined) {
      updates.push(`${column} = ?`);
      values.push(enabled ? 1 : 0);
    }
  }
  if (updates.length === 0) return getManifestSourceSettings(c);
  updates.push("updated_at = ?");
  values.push(now);
  await c.env.merlin_db
    .prepare(`UPDATE manifest_source_settings SET ${updates.join(", ")} WHERE id = 1`)
    .bind(...values)
    .run();

  return getManifestSourceSettings(c);
}
