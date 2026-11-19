import { afterAll, beforeAll, expect, test } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { listUserActivityLogs, writeUserActivityLog } from "../src/lib/user-activity-service";
import type { AppContext } from "../src/types";

let runtime: Miniflare;
let context: AppContext;

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-06-20", d1Databases: ["DB"],
  });
  const db = await runtime.getD1Database("DB");
  const schema = readFileSync(new URL("../migrations/0003_user_activity_logs.sql", import.meta.url), "utf8");
  await db.prepare("CREATE TABLE licenses (id INTEGER PRIMARY KEY)").run();
  await db.prepare("INSERT INTO licenses VALUES (1)").run();
  for (const statement of schema.split(";").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  context = { env: { merlin_db: db }, req: { header: (name: string) => name === "X-Merlin-Version" ? "2.5.3" : undefined } } as unknown as AppContext;
});

afterAll(async () => { await runtime?.dispose(); });

test("activity captures the installed launcher version without replacing the operation metadata", async () => {
  await writeUserActivityLog(context, {
    licenseId: 1, licenseKey: "TEST", userName: "Versão atual", action: "game_activation_success",
    status: "success", metadata: { source: "example" },
  });
  await writeUserActivityLog({ ...context, req: { header: () => "invalid value" } } as unknown as AppContext, {
    licenseId: 1, licenseKey: "TEST", userName: "Cliente anterior", action: "user_login_success", status: "success",
  });
  const { logs } = await listUserActivityLogs(context, { search: "Versão atual" });
  expect(logs[0]?.launcherVersion).toBe("2.5.3");
  expect(logs[0]?.metadata).toEqual({ source: "example", launcherVersion: "2.5.3" });
  expect((await listUserActivityLogs(context, { search: "Cliente anterior" })).logs[0]?.launcherVersion).toBeNull();
});

test("a whole day can be paged past 120 events without skipping equal timestamps or reading adjacent days", async () => {
  const db = context.env.merlin_db;
  const statement = db.prepare("INSERT INTO user_activity_logs (license_id, license_key, user_name, action, status, created_at) VALUES (1, 'TEST', 'Sintético', 'user_login_success', 'success', ?)");
  const start = "2026-11-18T03:00:00.000Z";
  const end = "2026-11-19T03:00:00.000Z";
  for (const timestamp of ["2026-11-18T02:59:59.999Z", end]) await statement.bind(timestamp).run();
  await db.batch(Array.from({ length: 80 }, () => statement.bind(start)));
  await db.batch(Array.from({ length: 72 }, () => statement.bind("2026-11-18T20:00:00.000Z")));
  const ids: number[] = [];
  let cursor: { beforeAt: string; beforeId: number } | null = null;
  do {
    const page = await listUserActivityLogs(context, {
      limit: 25, search: "Sintético", action: "user_login_success", from: start, to: end, ...cursor,
    });
    ids.push(...page.logs.map(log => log.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(152);
  expect(new Set(ids).size).toBe(152);
  expect(ids).toEqual([...ids].sort((a, b) => b - a));
  const timed = await listUserActivityLogs(context, { from: "2026-11-18T19:00:00.000Z", to: "2026-11-18T21:00:00.000Z", search: "Sintético" });
  expect(timed.logs).toHaveLength(72);
});
