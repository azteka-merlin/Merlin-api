import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: [{ find: "zlib-streams/zlib-streams.wasm",
    replacement: fileURLToPath(new URL("./src/lib/test-support/deflate64-wasm.mjs", import.meta.url)) }] },
  test: {
    // The streaming runner uses node:test; npm test runs it after Vitest.
    exclude: [...configDefaults.exclude, "scripts/custom-game-indexer.test.mjs"],
  },
});
