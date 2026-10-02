import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getExpirationReminderEligibility, runBillingNotificationCron } from "../src/lib/billing-notifications";
import { sendBillingEmail } from "../src/lib/billing-emails";
import type { AppBindings } from "../src/types";

vi.mock("../src/lib/billing-emails", () => ({ sendBillingEmail: vi.fn(async () => ({ id: "email-test" })) }));

function notificationEnv(sqlite: DatabaseSync) {
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args as []) }; },
        async first() { return sqlite.prepare(sql).get(...args as []) || null; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args as []).changes) } }; },
      };
    },
  };
  return { merlin_db: db, ENVIRONMENT: "production" } as unknown as AppBindings;
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY, customer_id INTEGER, license_key TEXT, name TEXT, contact TEXT,
      expires_at TEXT, access_type TEXT, billing_status TEXT, stripe_customer_id TEXT,
      stripe_subscription_id TEXT, billing_cancel_at_period_end INTEGER, status TEXT, contact_type TEXT
    );
    CREATE TABLE subscriptions (license_id INTEGER, status TEXT, cancel_at_period_end INTEGER);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, stripe_customer_id TEXT);
    CREATE TABLE checkout_sessions (
      provider TEXT, scheduled_renewal_license_id INTEGER, payment_status TEXT, renewal_applied_at TEXT
    );
  `);
  sqlite.exec(readFileSync(new URL("../migrations/0026_billing_notifications.sql", import.meta.url), "utf8"));
  const add = (id: number, expiresAt = "2026-10-09T15:00:00.000Z", accessType = "monthly_subscription",
    stripeId: string | null = null, cancel = 0, status = "active") => {
    sqlite.prepare(`
      INSERT INTO licenses
        (id, license_key, name, contact, expires_at, access_type, billing_status,
         stripe_subscription_id, billing_cancel_at_period_end, status, contact_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')
    `).run(id, `MERLIN-KEY-${id}`, `User ${id}`, `user${id}@example.com`,
      expiresAt, accessType, stripeId ? (cancel ? "canceled" : "active") : "pix_paid",
      stripeId, cancel, status);
    if (stripeId) sqlite.prepare("INSERT INTO subscriptions VALUES (?, ?, ?)").run(id, cancel ? "canceled" : "active", cancel);
  };
  return { sqlite, env: notificationEnv(sqlite), add };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("billing reminder cadence", () => {
  test("sends four reminders and two expired notices in São Paulo time, once per slot", async () => {
    vi.useFakeTimers();
    const { sqlite, env, add } = setup();
    add(1);
    const times = [
      ["2026-10-02T12:00:00.000Z", 0], // D-7 at 09: outside the exact renewal window.
      ["2026-10-02T22:00:00.000Z", 1], // D-7 at 19: inside the window.
      ["2026-10-05T12:00:00.000Z", 1],
      ["2026-10-07T12:00:00.000Z", 1],
      ["2026-10-08T22:00:00.000Z", 1],
      ["2026-10-09T12:00:00.000Z", 0], // No expired email on the expiry date.
      ["2026-10-10T12:00:00.000Z", 1],
      ["2026-10-11T22:00:00.000Z", 1],
      ["2026-10-12T12:00:00.000Z", 0],
    ] as const;
    for (const [time, expected] of times) {
      vi.setSystemTime(new Date(time));
      const result = await runBillingNotificationCron(env);
      expect(result.expirationSent + result.expiredSent).toBe(expected);
      const repeat = await runBillingNotificationCron(env);
      expect(repeat.expirationSent + repeat.expiredSent).toBe(0);
    }
    expect(sendBillingEmail).toHaveBeenCalledTimes(6);
    expect(sqlite.prepare("SELECT dedupe_key FROM billing_notifications ORDER BY id").all()
      .map((row) => String(row.dedupe_key).split(":").at(-1)))
      .toEqual(["d-7", "d-4", "d-2", "d-1", "d+1", "d+2"]);
    sqlite.close();
  });

  test("skips paid Pix renewals, auto-renewing cards, revoked and renewed licenses", async () => {
    vi.useFakeTimers();
    const { sqlite, env, add } = setup();
    add(1, "2026-10-09T15:00:00.000Z", "annual_manual");
    add(2);
    add(3, "2026-10-09T15:00:00.000Z", "monthly_subscription", "sub_3");
    add(4, "2026-10-09T15:00:00.000Z", "monthly_subscription", "sub_4", 1);
    add(5, "2026-10-09T15:00:00.000Z", "monthly_subscription", null, 0, "revoked");
    sqlite.prepare("INSERT INTO checkout_sessions VALUES ('mercadopago', 2, 'paid', NULL)").run();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    const first = await runBillingNotificationCron(env);
    expect(first.expirationSent).toBe(2); // Annual Pix and canceled card.
    expect(sqlite.prepare("SELECT license_id FROM billing_notifications ORDER BY license_id").all())
      .toEqual([{ license_id: 1 }, { license_id: 4 }]);
    sqlite.prepare("UPDATE licenses SET expires_at = '2026-11-09T15:00:00.000Z' WHERE id = 1").run();
    sqlite.prepare("INSERT INTO checkout_sessions VALUES ('mercadopago', 4, 'paid', NULL)").run();
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    expect((await runBillingNotificationCron(env)).expirationSent).toBe(0);
    sqlite.close();
  });

  test("a legacy reminder replaces the next scheduled email and the admin cannot send twice today", async () => {
    vi.useFakeTimers();
    const { sqlite, env, add } = setup();
    add(1);
    sqlite.prepare(`
      INSERT INTO billing_notifications
        (license_id, provider, notification_type, dedupe_key, email, status, sent_at, created_at, updated_at)
      VALUES (1, 'manual', 'manual_expiration_reminder', ?, 'user1@example.com', 'sent', ?, ?, ?)
    `).run("expiration_reminder:license:1:expires:2026-10-09",
      "2026-10-04T12:00:00.000Z", "2026-10-04T12:00:00.000Z", "2026-10-04T12:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    expect((await runBillingNotificationCron(env)).expirationSent).toBe(0);
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
    expect((await runBillingNotificationCron(env)).expirationSent).toBe(1);
    expect((await getExpirationReminderEligibility({ env }, 1)).eligible).toBe(false);
    sqlite.close();
  });

  test("an earlier expired email does not suppress the second day", async () => {
    vi.useFakeTimers();
    const { sqlite, env, add } = setup();
    add(1, "2026-10-09T15:00:00.000Z", "monthly_subscription", null, 0, "expired");
    sqlite.prepare(`
      INSERT INTO billing_notifications
        (license_id, provider, notification_type, dedupe_key, email, status, sent_at, created_at, updated_at)
      VALUES (1, 'manual', 'access_expired', ?, 'user1@example.com', 'sent', ?, ?, ?)
    `).run("access_expired:license:1:expires:2026-10-09",
      "2026-10-10T12:00:00.000Z", "2026-10-10T12:00:00.000Z", "2026-10-10T12:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    expect((await runBillingNotificationCron(env)).expiredSent).toBe(0);
    vi.setSystemTime(new Date("2026-10-11T22:00:00.000Z"));
    expect((await runBillingNotificationCron(env)).expiredSent).toBe(1);
    sqlite.close();
  });
});
