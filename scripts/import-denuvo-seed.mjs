#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { argv, exit, stderr } from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { getD1DatabaseName } from "./wrangler-config.mjs";

const [workbookPath, environment = "production"] = argv.slice(2);
if (!workbookPath) {
  console.error("Usage: npm run catalog:seed-denuvo -- <workbook.xlsx> [staging|production]");
  exit(1);
}

const databaseName = getD1DatabaseName(environment);
if (!databaseName) {
  console.error(`Could not find a D1 database for environment "${environment}".`);
  exit(1);
}

const workbook = XLSX.readFile(workbookPath, { cellText: false, cellDates: false });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const games = new Map();
for (const row of XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }).slice(4)) {
  const name = String(row[0] || "").trim();
  const appId = String(row[1] || "").trim();
  if (/^\d+$/.test(appId) && name) games.set(appId, { appId, name });
}
if (!games.size) {
  console.error("No valid AppIDs were found in the workbook.");
  exit(1);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeName(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function runSql(sql) {
  const args = ["wrangler", "d1", "execute", databaseName, "--remote"];
  if (environment !== "production") args.push("--env", environment);
  args.push("--command", sql);
  const options = { encoding: "utf8", env: { ...process.env, CI: process.env.CI || "1" } };
  const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const result = spawnSync(process.execPath, [wranglerBin, ...args.slice(1)], options);
  if (result.status !== 0) {
    stderr.write(result.stderr || result.stdout || "Could not execute the D1 import.\n");
    exit(result.status || 1);
  }
}

const entries = [...games.values()];
for (let index = 0; index < entries.length; index += 50) {
  const group = entries.slice(index, index + 50);
  const catalogValues = group.map((game) => `(${sqlText(game.appId)}, ${sqlText(game.name)}, ${sqlText(normalizeName(game.name))}, NULL, 'denuvo_seed', datetime('now'), datetime('now'))`).join(",");
  const metadataValues = group.map((game) => `(${sqlText(game.appId)}, 'premium', 1, 'Denuvo', 'seed', datetime('now'), datetime('now', '+1 hour'))`).join(",");
  const ids = group.map((game) => sqlText(game.appId)).join(",");
  runSql(`
    INSERT INTO catalog_games (app_id, name, normalized_name, cover_url, discovered_from, first_seen_at, last_seen_at)
    VALUES ${catalogValues}
    ON CONFLICT(app_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at;
    INSERT INTO catalog_game_metadata (app_id, category, denuvo, drm_notice, drm_source, checked_at, expires_at)
    VALUES ${metadataValues}
    ON CONFLICT(app_id) DO UPDATE SET category = 'premium', denuvo = 1, drm_notice = 'Denuvo', drm_source = 'seed', checked_at = excluded.checked_at, expires_at = excluded.expires_at;
    INSERT INTO catalog_enrichment_jobs (app_id, status, next_attempt_at, locked_until, updated_at)
    SELECT app_id, 'completed', datetime('now'), NULL, datetime('now') FROM catalog_game_metadata WHERE app_id IN (${ids})
    ON CONFLICT(app_id) DO UPDATE SET status = 'completed', locked_until = NULL, updated_at = excluded.updated_at;
  `);
  console.log(`Seeded ${Math.min(index + group.length, entries.length)}/${entries.length} Denuvo games.`);
}
