#!/usr/bin/env node
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output, argv } from "node:process";

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = "sha256";

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

function hashAdminPassword(password) {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(derived)}`;
}

function hashPreview(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function validateUsername(value) {
  return /^[a-zA-Z0-9._-]{3,48}$/.test(value);
}

function validatePassword(value) {
  return value.length >= 8;
}

function readOption(name) {
  const direct = argv.find((entry) => entry.startsWith(`${name}=`));
  if (direct) {
    return direct.slice(name.length + 1).trim();
  }

  const index = argv.indexOf(name);
  if (index >= 0) {
    return (argv[index + 1] || "").trim();
  }

  return "";
}

async function collectCredentials() {
  const usernameArg = readOption("--username");
  const passwordArg = readOption("--password");

  if (usernameArg || passwordArg) {
    if (!usernameArg || !passwordArg) {
      throw new Error("Se usar argumentos, informe --username e --password juntos.");
    }

    return {
      username: usernameArg,
      password: passwordArg,
    };
  }

  const rl = readline.createInterface({ input, output });

  try {
    const username = (await rl.question("Username do admin: ")).trim();
    const password = await rl.question("Senha do admin (min. 8 caracteres): ");
    const confirmPassword = await rl.question("Confirme a senha: ");

    if (password !== confirmPassword) {
      throw new Error("As senhas nao conferem.");
    }

    return { username, password };
  } finally {
    rl.close();
  }
}

async function main() {
  const { username, password } = await collectCredentials();

  if (!validateUsername(username)) {
    throw new Error("Username invalido. Use 3-48 caracteres: letras, numeros, ponto, underline ou hifen.");
  }

  if (!validatePassword(password)) {
    throw new Error("Senha invalida. Use pelo menos 8 caracteres.");
  }

  const now = new Date().toISOString();
  const passwordHash = hashAdminPassword(password);
  const sql = [
    "INSERT INTO admin_users (username, password_hash, role, status, failed_login_count, locked_until, last_login_at, created_at, updated_at)",
    `VALUES ('${escapeSql(username)}', '${escapeSql(passwordHash)}', 'admin', 'active', 0, NULL, NULL, '${now}', '${now}');`,
  ].join("\n");

  console.log("\nAdmin bootstrap pronto.");
  console.log(`Username: ${username}`);
  console.log(`Fingerprint local: ${hashPreview(username + ":" + passwordHash)}`);
  console.log("\nExecute este comando para inserir no D1 remoto:");
  console.log(`npx wrangler d1 execute merlin-db --remote --command \"${sql.replace(/\"/g, '\\\"')}\"`);
  console.log("\nSQL gerado:");
  console.log(sql);
}

main().catch((error) => {
  console.error(`\nErro: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

