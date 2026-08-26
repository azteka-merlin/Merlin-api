import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const legacySchema = `
  CREATE TABLE licenses (id INTEGER PRIMARY KEY);
  CREATE TABLE premium_games (app_id TEXT PRIMARY KEY);
  CREATE TABLE premium_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id INTEGER NOT NULL,
    app_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'expired', 'failed')),
    reserved_at TEXT,
    activated_at TEXT,
    cooldown_until TEXT,
    failure_stage TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (license_id) REFERENCES licenses(id),
    FOREIGN KEY (app_id) REFERENCES premium_games(app_id)
  );
  CREATE INDEX idx_premium_activations_app_id ON premium_activations(app_id);
  CREATE INDEX idx_premium_activations_license_id ON premium_activations(license_id);
  CREATE INDEX idx_premium_activations_status ON premium_activations(status);
  CREATE INDEX idx_premium_activations_cooldown_until ON premium_activations(cooldown_until);
  CREATE INDEX idx_premium_activations_app_status_cooldown ON premium_activations(app_id, status, cooldown_until);
  CREATE INDEX idx_premium_activations_license_app_status ON premium_activations(license_id, app_id, status);
  CREATE INDEX idx_premium_activations_license_status ON premium_activations(license_id, status);
  INSERT INTO licenses (id) VALUES (1);
  INSERT INTO premium_games (app_id) VALUES ('3321460');
  INSERT INTO premium_activations (id, license_id, app_id, status, reserved_at, created_at, updated_at)
  VALUES (86, 1, '3321460', 'reserved', '2026-08-26T20:36:49.760Z', '2026-08-26T20:36:49.760Z', '2026-08-26T20:36:49.760Z');
`;

const expectedIndexes = [
  "idx_premium_activations_app_id",
  "idx_premium_activations_app_status_cooldown",
  "idx_premium_activations_cooldown_until",
  "idx_premium_activations_license_app_status",
  "idx_premium_activations_license_id",
  "idx_premium_activations_license_status",
  "idx_premium_activations_status",
];

describe("premium activation processing migration", () => {
  test("preserves reservations and permits the processing to active transition", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(legacySchema);
    db.exec(readFileSync(resolve(process.cwd(), "migrations/0045_premium_activation_processing_status.sql"), "utf8"));

    expect(db.prepare("SELECT id, status FROM premium_activations WHERE id = 86").get())
      .toEqual({ id: 86, status: "reserved" });

    db.prepare("UPDATE premium_activations SET status = 'processing' WHERE id = 86").run();
    db.prepare("UPDATE premium_activations SET status = 'active' WHERE id = 86").run();

    expect(db.prepare("SELECT status FROM premium_activations WHERE id = 86").get())
      .toEqual({ status: "active" });

    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'premium_activations'
      ORDER BY name
    `).all().map((row) => row.name);
    expect(indexes).toEqual(expectedIndexes);

    db.close();
  });
});
