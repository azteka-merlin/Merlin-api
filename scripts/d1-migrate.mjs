#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { argv, exit, platform } from "node:process";
import { getD1DatabaseName } from "./wrangler-config.mjs";

const environment = argv[2] || "production";
const databaseName = getD1DatabaseName(environment);

if (!databaseName) {
	console.error(`Could not find a D1 database_name for environment "${environment}" in wrangler.jsonc.`);
	exit(1);
}

const args = ["wrangler", "d1", "migrations", "apply", databaseName, "--remote"];
if (environment !== "production") {
	args.push("--env", environment);
}

const result = spawnSync(platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit" });
exit(result.status ?? 1);
