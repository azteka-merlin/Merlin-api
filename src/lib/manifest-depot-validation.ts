import { unzipSync } from "fflate";

const MAX_ZIP_BYTES = 24 * 1024 * 1024;
const MAX_LUA_BYTES = 2 * 1024 * 1024;
const PICS_TIMEOUT_MS = 10_000;

export async function getPicsDepotIds(env: { MERLIN_WORKER_URL?: string; MERLIN_WORKER_TOKEN?: string }, appId: string): Promise<string[]> {
  const baseUrl = env.MERLIN_WORKER_URL?.trim().replace(/\/$/, "");
  const token = env.MERLIN_WORKER_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("PICS worker is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PICS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/steam-depots?appid=${encodeURIComponent(appId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PICS worker HTTP ${response.status}`);
    const payload = await response.json() as { ok?: unknown; depotIds?: unknown };
    if (payload.ok !== true || !Array.isArray(payload.depotIds)
      || payload.depotIds.length === 0
      || !payload.depotIds.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
      throw new Error("PICS worker returned invalid depot metadata");
    }
    return [...new Set(payload.depotIds)];
  } finally {
    clearTimeout(timeout);
  }
}

function replayZip(response: Response, chunks: Uint8Array[], reader?: ReadableStreamDefaultReader<Uint8Array>): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset < chunks.length) {
        controller.enqueue(chunks[offset++]);
        return;
      }
      if (!reader) {
        controller.close();
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) { return reader?.cancel(reason); },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

export async function validateZipDepots(response: Response, appId: string, expectedDepotIds: string[]): Promise<{ response: Response; missingDepotIds: string[] | null; error?: string }> {
  if (!response.body) throw new Error("ZIP response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      size += part.value.byteLength;
      if (size > MAX_ZIP_BYTES) {
        return { response: replayZip(response, chunks, reader), missingDepotIds: null, error: "zip_too_large" };
      }
    }
  } catch (error) {
    return { response: replayZip(response, chunks, reader), missingDepotIds: null, error: error instanceof Error ? error.message : String(error) };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const retained = new Response(bytes, { status: response.status, headers: response.headers });
  const target = `${appId}.lua`.toLowerCase();
  try {
    const files = unzipSync(bytes, {
      filter: (file) => file.name.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === target
        && file.originalSize <= MAX_LUA_BYTES,
    });
    const lua = Object.values(files)[0];
    if (!lua) throw new Error("App Lua is missing or too large");
    const code = new TextDecoder().decode(lua)
      .replace(/--\[\[[\s\S]*?\]\]/g, "")
      .replace(/--[^\r\n]*/g, "");
    const found = new Set([...code.matchAll(/\baddappid\s*\(\s*(\d+)\s*[,)]/gi)].map((match) => match[1]));
    if (found.size === 0) throw new Error("App Lua contains no addappid calls");
    return { response: retained, missingDepotIds: expectedDepotIds.filter((id) => !found.has(id)) };
  } catch (error) {
    return { response: retained, missingDepotIds: null, error: error instanceof Error ? error.message : String(error) };
  }
}
