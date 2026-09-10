import type { AppContext } from "../types";

type LauncherUpdatePolicySettingsRow = {
  automatic_updates_enabled: number;
  updated_at: string;
};

export async function getLauncherUpdatePolicySettings(c: AppContext) {
  const row = await c.env.merlin_db
    .prepare("SELECT automatic_updates_enabled, updated_at FROM launcher_update_policy_settings WHERE id = 1")
    .first<LauncherUpdatePolicySettingsRow>();

  return {
    automaticUpdatesEnabled: row?.automatic_updates_enabled !== 0,
    updatedAt: row?.updated_at || null,
  };
}

export async function updateLauncherUpdatePolicySettings(c: AppContext, automaticUpdatesEnabled: boolean) {
  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(`
      INSERT INTO launcher_update_policy_settings (id, automatic_updates_enabled, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        automatic_updates_enabled = excluded.automatic_updates_enabled,
        updated_at = excluded.updated_at
    `)
    .bind(automaticUpdatesEnabled ? 1 : 0, now)
    .run();

  return getLauncherUpdatePolicySettings(c);
}
