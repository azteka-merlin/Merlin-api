// Test-only loader. Wrangler imports the real .wasm as a compiled Worker module.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export default new WebAssembly.Module(readFileSync(require.resolve("zlib-streams/zlib-streams.wasm")));
