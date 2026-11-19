import type { AppBindings } from "../types";
import { enqueueGameImage, validImageAppId } from "./game-images";

const MAX_BATCH = 60;
const MAX_QUEUE_BACKLOG = 120;
const MAX_INPUT_READ = 64 * 1024;
const LEASE_MS = 5 * 60 * 1000;

type ImportState = {
  id: string;
  total: number;
  processed: number;
  queued: number;
  stored: number;
  pending: number;
  offset: number;
  leaseUntil: number;
  status: "running" | "completed";
  updatedAt: string;
};

function importPrefix(env: AppBindings) {
  return "game-images/v1/" + env.ENVIRONMENT + "/imports/";
}

function stateKey(env: AppBindings) {
  return importPrefix(env) + "current.json";
}

async function readState(env: AppBindings) {
  const object = await env.MERLIN_FILES.get(stateKey(env));
  if (!object) return null;
  if (object.size > 8192) throw new Error("invalid_game_image_import_state");
  const state = await object.json<ImportState>();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(state.id) || !Number.isSafeInteger(state.total) ||
      !Number.isSafeInteger(state.processed) || state.processed < 0 || state.processed > state.total ||
      !Number.isSafeInteger(state.offset) || state.offset < 0 ||
      !["running", "completed"].includes(state.status)) {
    throw new Error("invalid_game_image_import_state");
  }
  return { state, etag: object.etag };
}

function putState(env: AppBindings, state: ImportState, etag: string) {
  return env.MERLIN_FILES.put(stateKey(env), JSON.stringify(state), {
    onlyIf: { etagMatches: etag },
    httpMetadata: { contentType: "application/json" },
  });
}

export async function getGameImageImportProgress(env: AppBindings) {
  const current = await readState(env);
  if (!current) return null;
  const { id, status, total, processed, queued, stored, pending, updatedAt } = current.state;
  return { id, status, total, processed, queued, stored, pending, updatedAt };
}

async function readBatch(env: AppBindings, state: ImportState, count: number) {
  const inputKey = importPrefix(env) + state.id + "/games.ndjson";
  const object = await env.MERLIN_FILES.get(inputKey, { range: { offset: state.offset, length: MAX_INPUT_READ } });
  if (!object) throw new Error("game_image_import_input_missing");
  const text = await object.text();
  const lastLine = text.lastIndexOf("\n");
  if (lastLine < 0) throw new Error("game_image_import_input_truncated");

  const lines = text.slice(0, lastLine).split("\n").slice(0, count);
  const games = lines.map(line => {
    const game = JSON.parse(line) as { appId: string; sourceUrl?: string };
    if (!game || typeof game.appId !== "string" || !validImageAppId(game.appId) ||
        (game.sourceUrl !== undefined && (typeof game.sourceUrl !== "string" || game.sourceUrl.length > 600))) {
      throw new Error("invalid_game_image_import_entry");
    }
    return game;
  });
  const offset = state.offset + new TextEncoder().encode(lines.join("\n") + "\n").length;
  if ((state.processed + games.length === state.total) !== (offset === object.size)) {
    throw new Error("game_image_import_input_count_mismatch");
  }
  return { games, offset };
}

export async function dispatchGameImageImport(env: AppBindings) {
  if (!env.GAME_IMAGE_QUEUE || !env.MERLIN_FILES) return;
  const current = await readState(env);
  if (!current || current.state.status !== "running" || current.state.leaseUntil > Date.now()) return;

  const metrics = await env.GAME_IMAGE_QUEUE.metrics();
  const available = Math.min(MAX_BATCH, MAX_QUEUE_BACKLOG - metrics.backlogCount, current.state.total - current.state.processed);
  if (available < 1) return;

  const leased = await putState(env, { ...current.state, leaseUntil: Date.now() + LEASE_MS }, current.etag);
  if (!leased) return;
  const state = { ...current.state };
  try {
    const batch = await readBatch(env, state, available);
    for (let start = 0; start < batch.games.length; start += 4) {
      const results = await Promise.allSettled(batch.games.slice(start, start + 4).map(game =>
        enqueueGameImage(env, game.appId, "import", game.sourceUrl)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        if (result.value !== "queued" && result.value !== "stored" && result.value !== "pending") {
          throw new Error("game_image_import_enqueue_unavailable");
        }
        state[result.value]++;
      }
    }
    state.processed += batch.games.length;
    state.offset = batch.offset;
    state.updatedAt = new Date().toISOString();
    if (state.processed === state.total) state.status = "completed";
    await putState(env, { ...state, leaseUntil: 0 }, leased.etag);
  } catch (error) {
    // Retry the same slice on the next tick. Enqueue uses the same AppID lease
    // and skips already saved images, so a partially sent batch is safe.
    await putState(env, { ...current.state, leaseUntil: 0 }, leased.etag).catch(() => {});
    throw error;
  }
}
