import type { AppContext } from "../types";
import { sendAdminAlertPush } from "./admin-push";

const STEAM_CONNECTION_KEY = "steam_connection:merlin-worker";
const STEAM_CONNECTION_PATTERNS = [
  /steam client is not running/i,
  /k_EResultNoConnection/i,
  /steamapi_init[^\r\n]{0,80}(failed|error)/i,
  /(?:not connected to|cannot connect to|failed to connect to) steam/i,
];

type WorkerResult = {
  status: number;
  ok: boolean;
  payload: unknown;
  error: unknown;
};

type AlertRow = {
  id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  occurrence_count: number;
  first_occurred_at: string;
  last_occurred_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

function workerPayload(worker: WorkerResult | null): Record<string, unknown> | null {
  return worker?.payload && typeof worker.payload === "object" && !Array.isArray(worker.payload)
    ? worker.payload as Record<string, unknown>
    : null;
}

function detectionText(worker: WorkerResult | null): string {
  const payload = workerPayload(worker);
  const error = worker?.error && typeof worker.error === "object" ? worker.error as Record<string, unknown> : null;
  return [payload?.message, payload?.error, payload?.stdout, payload?.stderr, payload?.logOutput, error?.upstreamBody]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(0, 8000))
    .join("\n");
}

export function steamConnectionFailureCode(worker: WorkerResult | null): string | null {
  if (!worker || worker.ok) return null;
  const text = detectionText(worker);
  const index = STEAM_CONNECTION_PATTERNS.findIndex((pattern) => pattern.test(text));
  return index < 0 ? null : ["steam_client_not_running", "steam_no_connection", "steam_api_init_failed", "steam_connection_failed"][index] ?? null;
}

export function safeWorkerContext(worker: WorkerResult, failureCode: string) {
  const payload = workerPayload(worker);
  const error = worker.error && typeof worker.error === "object" ? worker.error as Record<string, unknown> : null;
  const exitCode = typeof payload?.exitCode === "number" || typeof payload?.exitCode === "string"
    ? String(payload.exitCode) : "";
  const signal = typeof payload?.signal === "string" ? payload.signal : "";
  return {
    failureCode,
    workerHttpStatus: Number.isInteger(worker.status) ? worker.status : null,
    workerMessage: typeof payload?.message === "string" && /^[a-z_]{1,64}$/.test(payload.message) ? payload.message : null,
    workerJobId: typeof payload?.jobId === "string" && /^[a-f0-9-]{1,64}$/i.test(payload.jobId) ? payload.jobId : null,
    exitCode: /^(?:-?\d+|0x[0-9a-fA-F]+|[A-Z_]{1,24})$/.test(exitCode) ? exitCode : null,
    killed: payload?.killed === true,
    signal: /^[A-Z0-9_]{1,24}$/.test(signal) ? signal : null,
    upstreamStatus: typeof error?.upstreamStatus === "number" ? error.upstreamStatus : null,
  };
}

export async function recordSteamConnectionFailure(
  c: AppContext,
  input: { licenseId: number; appId: string; gameName: string | null; worker: WorkerResult; source: string },
): Promise<boolean> {
  const failureCode = steamConnectionFailureCode(input.worker);
  if (!failureCode) return false;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const summary = "O worker não conseguiu se conectar à Steam durante uma ativação Premium.";
  const alert = await c.env.merlin_db.prepare(`
    INSERT INTO admin_alerts (
      id, type, severity, status, title, summary, active_key, occurrence_count,
      first_occurred_at, last_occurred_at, created_at, updated_at
    ) VALUES (?, 'steam_connection', 'critical', 'open', 'Steam desconectada no worker', ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(active_key) DO UPDATE SET
      occurrence_count = admin_alerts.occurrence_count + 1,
      last_occurred_at = excluded.last_occurred_at,
      updated_at = excluded.updated_at
    RETURNING id, occurrence_count
  `).bind(id, summary, STEAM_CONNECTION_KEY, now, now, now, now)
    .first<{ id: string; occurrence_count: number }>();
  if (!alert) throw new Error("Could not create admin alert");

  try {
    await c.env.merlin_db.prepare(`
      INSERT INTO admin_alert_events (
        id, alert_id, source, license_id, app_id, game_name, message, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), alert.id, input.source, input.licenseId, input.appId,
      input.gameName?.slice(0, 200) || null,
      "O gerador não conseguiu usar a sessão da Steam.",
      JSON.stringify(safeWorkerContext(input.worker, failureCode)), now,
    ).run();
  } catch (error) {
    console.error("[admin-alerts] could not store incident occurrence", error instanceof Error ? error.message : "Unknown error");
  }

  if (alert.occurrence_count === 1) {
    try {
      c.executionCtx.waitUntil(sendAdminAlertPush(c.env, {
        id: alert.id,
        title: "Steam desconectada",
        body: "O worker não conseguiu conectar à Steam. Abra Alertas para ver os detalhes.",
      }).catch((error) => {
        console.error("[admin-alerts] push delivery failed", error instanceof Error ? error.message : "Unknown error");
      }));
    } catch (error) {
      console.error("[admin-alerts] push scheduling failed", error instanceof Error ? error.message : "Unknown error");
    }
  }
  return true;
}

export async function listAdminAlerts(c: AppContext, options: { status?: string; type?: string; limit?: number; offset?: number } = {}) {
  const status = options.status && ["open", "acknowledged", "resolved"].includes(options.status) ? options.status : null;
  const type = options.type && /^[a-z_]{1,64}$/.test(options.type) ? options.type : null;
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const offset = Math.min(Math.max(Number(options.offset) || 0, 0), 100000);
  const rows = await c.env.merlin_db.prepare(`
    SELECT id, type, severity, status, title, summary, occurrence_count,
      first_occurred_at, last_occurred_at, acknowledged_at, resolved_at
    FROM admin_alerts
    WHERE (? IS NULL OR status = ?) AND (? IS NULL OR type = ?)
    ORDER BY CASE WHEN status = 'resolved' THEN 1 ELSE 0 END, last_occurred_at DESC
    LIMIT ? OFFSET ?
  `).bind(status, status, type, type, limit + 1, offset).all<AlertRow>();
  const results = rows.results || [];
  return { alerts: results.slice(0, limit), hasMore: results.length > limit };
}

export async function getAdminAlert(c: AppContext, id: string) {
  const alert = await c.env.merlin_db.prepare(`
    SELECT id, type, severity, status, title, summary, occurrence_count,
      first_occurred_at, last_occurred_at, acknowledged_at, resolved_at
    FROM admin_alerts WHERE id = ?
  `).bind(id).first<AlertRow>();
  if (!alert) return null;
  const events = await c.env.merlin_db.prepare(`
    SELECT id, source, license_id, app_id, game_name, message, payload_json, occurred_at
    FROM admin_alert_events WHERE alert_id = ? ORDER BY occurred_at DESC LIMIT 100
  `).bind(id).all<{
    id: string; source: string; license_id: number | null; app_id: string | null;
    game_name: string | null; message: string; payload_json: string; occurred_at: string;
  }>();
  return {
    ...alert,
    events: (events.results || []).map((event) => ({
      id: event.id,
      source: event.source,
      licenseId: event.license_id,
      appId: event.app_id,
      gameName: event.game_name,
      message: event.message,
      payload: JSON.parse(event.payload_json),
      occurredAt: event.occurred_at,
    })),
  };
}

export async function updateAdminAlertStatus(c: AppContext, id: string, status: "acknowledged" | "resolved", adminUserId: number) {
  const now = new Date().toISOString();
  const result = status === "acknowledged"
    ? await c.env.merlin_db.prepare(`
      UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).bind(now, adminUserId, now, id).run()
    : await c.env.merlin_db.prepare(`
      UPDATE admin_alerts SET status = 'resolved', active_key = NULL, resolved_at = ?, resolved_by = ?, updated_at = ?
      WHERE id = ? AND status IN ('open', 'acknowledged')
    `).bind(now, adminUserId, now, id).run();
  return (result.meta.changes || 0) > 0;
}
