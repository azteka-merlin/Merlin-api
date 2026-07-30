import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function stripJsonc(value) {
	let output = "";
	let inString = false;
	let quote = "";
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const current = value[index];
		const next = value[index + 1];

		if (inString) {
			output += current;

			if (escaped) {
				escaped = false;
			} else if (current === "\\") {
				escaped = true;
			} else if (current === quote) {
				inString = false;
				quote = "";
			}

			continue;
		}

		if (current === '"' || current === "'") {
			inString = true;
			quote = current;
			output += current;
			continue;
		}

		if (current === "/" && next === "/") {
			while (index < value.length && value[index] !== "\n") {
				index += 1;
			}
			output += "\n";
			continue;
		}

		if (current === "/" && next === "*") {
			index += 2;
			while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) {
				if (value[index] === "\n") output += "\n";
				index += 1;
			}
			index += 1;
			continue;
		}

		output += current;
	}

	return output;
}

export function readWranglerConfig() {
	const configPath = resolve("wrangler.jsonc");
	const raw = readFileSync(configPath, "utf8");
	const json = stripJsonc(raw).replace(/,\s*([}\]])/g, "$1");
	return JSON.parse(json);
}

export function getD1DatabaseName(environment = "production") {
	const config = readWranglerConfig();
	const environmentConfig = environment === "production" ? config : config.env?.[environment];
	const database = environmentConfig?.d1_databases?.[0] ?? config.d1_databases?.[0];
	return database?.database_name;
}
