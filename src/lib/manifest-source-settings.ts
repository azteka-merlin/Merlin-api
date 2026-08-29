import type { AppContext } from "../types";

export const MANIFEST_PRIMARY_SOURCES = ["depotbox", "ryuu"] as const;

export type ManifestPrimarySource = (typeof MANIFEST_PRIMARY_SOURCES)[number];

export const DEFAULT_MANIFEST_PRIMARY_SOURCE: ManifestPrimarySource = "depotbox";

type ManifestSourceSettingsRow = {
  primary_source: string;
  updated_at: string;
};

function normalizePrimarySource(value: unknown): ManifestPrimarySource {
  return value === "ryuu" ? "ryuu" : DEFAULT_MANIFEST_PRIMARY_SOURCE;
}

export function manifestPrimarySourceOrder(value: unknown): ManifestPrimarySource[] {
  const primarySource = normalizePrimarySource(value);
  return primarySource === "ryuu" ? ["ryuu", "depotbox"] : ["depotbox", "ryuu"];
}

export async function getManifestSourceSettings(c: AppContext) {
  const row = await c.env.merlin_db
    .prepare("SELECT primary_source, updated_at FROM manifest_source_settings WHERE id = 1")
    .first<ManifestSourceSettingsRow>();

  return {
    primarySource: normalizePrimarySource(row?.primary_source),
    updatedAt: row?.updated_at || null,
  };
}

export async function updateManifestSourceSettings(c: AppContext, primarySource: ManifestPrimarySource) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      INSERT INTO manifest_source_settings (id, primary_source, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        primary_source = excluded.primary_source,
        updated_at = excluded.updated_at
    `)
    .bind(primarySource, now)
    .run();

  return getManifestSourceSettings(c);
}
