import { describe, it, expect, vi } from "vitest";
import type { AppBindings } from "../types";
import { readShardedFolderIndex, streamShardedFolderManifest, streamShardedIntegrityManifest } from "./custom-game-sharded-download";
import { referencedGameFileKeys } from "./custom-game-package-lifecycle";
import { ensureShardedIntegrityBaseline, integrityManifestKey } from "./custom-game-integrity";

const game = "11111111-1111-4111-8111-111111111111";
const manifest = "22222222-2222-4222-8222-222222222222";
const file = "33333333-3333-4333-8333-333333333333";
const bundle = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);
const archiveKey = `${game}/manifests/${manifest}.json`;
const partKeys = [0, 1].map(i => `${game}/manifest-parts/${manifest}/${String(i).padStart(6, "0")}.json`);
const index = { version: 4, totalSizeBytes: 3, parts: partKeys.map(key => ({ key })), objects: {
  [file]: { key: `${game}/files/${file}`, sizeBytes: 1, sha256: sha, kind: "file", parts: [0] },
  [bundle]: { key: `${game}/files/${bundle}`, sizeBytes: 20, sha256: sha, kind: "bundle", parts: [0, 1] },
} };
const parts = [
  { entries: [{ kind: "file", key: `${game}/files/${file}`, path: "one.txt", sizeBytes: 1, sha256: sha },
    { kind: "bundle", key: `${game}/files/${bundle}`, sizeBytes: 20, sha256: sha, fragmentIndex: 0, fragmentCount: 2,
      files: [{ path: "dir/a", sizeBytes: 1, sha256: sha }] }] },
  { entries: [{ kind: "bundle", key: `${game}/files/${bundle}`, sizeBytes: 20, sha256: sha, fragmentIndex: 1, fragmentCount: 2,
    files: [{ path: "dir/b", sizeBytes: 1, sha256: sha }] }] },
];
function setup() {
  const objects = new Map<string, unknown>([[archiveKey, index], [partKeys[0]!, parts[0]!], [partKeys[1]!, parts[1]!]]);
  return { CUSTOM_GAMES: {
    head: async (key: string) => objects.has(key) ? { size: JSON.stringify(objects.get(key)).length } : null,
    get: async (key: string) => objects.has(key) ? { size: JSON.stringify(objects.get(key)).length, json: async () => objects.get(key) } : null,
  } } as unknown as AppBindings;
}
describe("partitioned folder download", () => {
  it("streams the legacy manifest and integrity contracts across fragment boundaries", async () => {
    const env = setup(); const value = await readShardedFolderIndex(env, archiveKey);
    expect(value).not.toBeNull();
    const result = await new Response(streamShardedFolderManifest(env, value!, game, archiveKey)).json() as any;
    expect(result.files.map((f: any) => f.path)).toEqual(["one.txt"]);
    expect(result.bundles[0].files.map((f: any) => f.path)).toEqual(["dir/a", "dir/b"]);
    const integrity = await new Response(streamShardedIntegrityManifest(env, value!, game, archiveKey)).json() as any;
    expect(integrity.files.map((f: any) => f.path)).toEqual(["one.txt", "dir/a", "dir/b"]);
  });
  it("rejects an index referencing a part outside its manifest prefix", async () => {
    const env = setup();
    const invalidIndex = structuredClone(index); invalidIndex.parts[0]!.key = "other/000000.json";
    env.CUSTOM_GAMES.head = (async () => ({ size: 100 })) as any;
    env.CUSTOM_GAMES.get = (async () => ({ json: async () => invalidIndex })) as any;
    await expect(readShardedFolderIndex(env, archiveKey)).rejects.toThrow();
  });
  it("preserves an object shared with another partitioned version", async () => {
    const env = setup();
    env.merlin_db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ archive_key: archiveKey }] }) }) }) } as any;
    const shared = `${game}/files/${bundle}`;
    const unrelated = `${game}/files/55555555-5555-4555-8555-555555555555`;
    expect(await referencedGameFileKeys(env, [shared, unrelated], { gameId: game })).toEqual(new Set([shared]));
  });
  it("retries interrupted baseline creation and reuses the durable baseline", async () => {
    const env = setup();
    const existingGet = env.CUSTOM_GAMES.get.bind(env.CUSTOM_GAMES);
    const existingHead = env.CUSTOM_GAMES.head.bind(env.CUSTOM_GAMES);
    const baselineKey = await integrityManifestKey(game, archiveKey);
    let stored: { data: Uint8Array; metadata: Record<string, string> } | undefined;
    let failNext = true;
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_size: number) { super(); } });
    try {
      env.CUSTOM_GAMES.head = (async (key: string) => key === baselineKey
        ? stored ? { size: stored.data.byteLength, customMetadata: stored.metadata } : null
        : existingHead(key)) as any;
      env.CUSTOM_GAMES.get = (async (key: string) => key === baselineKey
        ? stored ? { size: stored.data.byteLength, customMetadata: stored.metadata, body: new Response(stored.data).body } : null
        : existingGet(key)) as any;
      env.CUSTOM_GAMES.put = (async (_key: string, body: ReadableStream<Uint8Array>, options: any) => {
        if (failNext) { failNext = false; throw new Error("synthetic interruption"); }
        const data = new Uint8Array(await new Response(body).arrayBuffer());
        stored = { data, metadata: options.customMetadata };
        return { size: data.byteLength, customMetadata: stored.metadata };
      }) as any;
      const snapshot = { id: game, archive_key: archiveKey, archive_size: 3, package_type: "folder" as const };
      await expect(ensureShardedIntegrityBaseline(env, snapshot)).rejects.toThrow("synthetic interruption");
      expect(stored).toBeUndefined();
      expect(await ensureShardedIntegrityBaseline(env, snapshot)).toBe(true);
      const decoded = JSON.parse(new TextDecoder().decode(stored!.data));
      expect(decoded.files).toHaveLength(3);
      expect(await ensureShardedIntegrityBaseline(env, snapshot)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
