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

const env = { ...process.env, CI: process.env.CI || "1" };
const result = platform === "win32"
	? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "npx", ...args], { stdio: "inherit", env })
	: spawnSync("npx", args, { stdio: "inherit", env });
exit(result.status ?? 1);
