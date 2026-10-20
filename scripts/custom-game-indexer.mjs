#!/usr/bin/env node
import { configurationFromEnv, IndexerClient, runIndexer, safeError } from "./lib/custom-game-indexer.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Uso: node scripts/custom-game-indexer.mjs [--once]

Indexa ZIPs e pastas legadas pela fila da API Merlin.
--once processa no máximo um job e encerra; sem opção acompanha a fila.

Obrigatórios: CUSTOM_GAME_INDEXER_API_URL, CUSTOM_GAME_INDEXER_SECRET.
Opcionais: CUSTOM_GAME_INDEXER_TEMP_DIR, CUSTOM_GAME_INDEXER_POLL_MS,
CUSTOM_GAME_INDEXER_RANGE_BYTES, CUSTOM_GAME_INDEXER_MAX_ARCHIVE_BYTES,
CUSTOM_GAME_INDEXER_MAX_GAME_BYTES, CUSTOM_GAME_INDEXER_MAX_FILE_BYTES,
CUSTOM_GAME_INDEXER_RESERVE_DISK_BYTES.
Veja docs/CUSTOM_GAME_INDEXER_RUNNER.md.`);
} else if (args.some(arg => arg !== "--once")) {
  console.error("Opção desconhecida. Use --help.");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const shutdown = () => controller.abort(new Error("Indexador interrompido; o job voltará à fila quando o lease expirar."));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const config = configurationFromEnv();
    const client = new IndexerClient(config);
    await runIndexer({ ...config, client, once: args.includes("--once"), signal: controller.signal });
  } catch (error) {
    console.error(safeError(error, [process.env.CUSTOM_GAME_INDEXER_SECRET]));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
