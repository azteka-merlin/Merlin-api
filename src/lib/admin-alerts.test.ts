import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL as NodeURL } from "node:url";
import { getAdminAlert, listAdminAlerts, recordSteamConnectionFailure, safeWorkerContext, steamConnectionFailureCode, updateAdminAlertStatus } from "./admin-alerts";

function testContext() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE admin_users (id INTEGER PRIMARY KEY); CREATE TABLE licenses (id INTEGER PRIMARY KEY);");
  db.exec(readFileSync(new NodeURL("../../migrations/0084_admin_alerts.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO admin_users(id) VALUES (1); INSERT INTO licenses(id) VALUES (132);");
  const merlin_db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = db.prepare(sql);
          return {
            async first<T>() { return statement.get(...values as []) as T | null; },
            async all<T>() { return { results: statement.all(...values as []) as T[] }; },
            async run() { return { meta: { changes: statement.run(...values as []).changes } }; },
          };
        },
      };
    },
  };
  return {
    db,
    context: { env: { merlin_db }, executionCtx: { waitUntil() {} } } as never,
  };
}

describe("Steam connection alert classification", () => {
  it("recognizes Steam client not running without classifying unrelated failures", () => {
    expect(steamConnectionFailureCode({
      status: 502, ok: false,
      payload: { message: "generator_failed", stdout: "Steam client is not running" }, error: null,
    })).toBe("steam_client_not_running");
    expect(steamConnectionFailureCode({
      status: 502, ok: false,
      payload: { message: "generator_failed", stderr: "0xC0000139: entry point not found" }, error: null,
    })).toBeNull();
    expect(steamConnectionFailureCode({
      status: 200, ok: true,
      payload: { stdout: "Steam client is not running" }, error: null,
    })).toBeNull();
  });

  it("recognizes the generator's no-connection result", () => {
    expect(steamConnectionFailureCode({
      status: 502, ok: false,
      payload: { logOutput: "RequestEncryptedAppTicket: k_EResultNoConnection" }, error: null,
    })).toBe("steam_no_connection");
  });

  it("never stores raw stdout, ticket or token in the Admin alert payload", () => {
    const context = safeWorkerContext({
      status: 502, ok: false,
      payload: {
        message: "generator_failed", exitCode: 1, jobId: "00000000-0000-4000-8000-000000000000",
        stdout: "Steam client is not running\nEncrypted App Ticket: secret-ticket",
        parsed: { token: "secret-token" },
      },
      error: { upstreamStatus: 502, upstreamBody: "secret-body" },
    }, "steam_client_not_running");
    const stored = JSON.stringify(context);
    expect(context.failureCode).toBe("steam_client_not_running");
    expect(stored).not.toContain("secret-ticket");
    expect(stored).not.toContain("secret-token");
    expect(stored).not.toContain("secret-body");
  });

  it("groups repeated failures, retains individual contexts and opens a new incident after resolution", async () => {
    const { db, context } = testContext();
    const worker = {
      status: 502, ok: false,
      payload: { message: "generator_failed", stdout: "Steam client is not running; ticket=secret-ticket", exitCode: 1 },
      error: null,
    };
    const input = { licenseId: 132, appId: "4231820", gameName: "Belmont", worker, source: "premium_activation" };
    await recordSteamConnectionFailure(context, input);
    await recordSteamConnectionFailure(context, input);
    const firstList = await listAdminAlerts(context);
    expect(firstList.alerts).toHaveLength(1);
    expect(firstList.alerts[0]?.occurrence_count).toBe(2);
    const detail = await getAdminAlert(context, firstList.alerts[0]!.id);
    expect(detail?.events).toHaveLength(2);
    expect(detail?.events[0]?.licenseId).toBe(132);
    expect(JSON.stringify(detail)).not.toContain("secret-ticket");

    expect(await updateAdminAlertStatus(context, firstList.alerts[0]!.id, "resolved", 1)).toBe(true);
    await recordSteamConnectionFailure(context, input);
    expect((await listAdminAlerts(context)).alerts).toHaveLength(2);
    db.close();
  });
});
