import { afterEach, describe, expect, it, vi } from "vitest";
import { metadataFromRow, normalizeDiscordUrl, normalizeRepositoryUrl, portReleaseStatus, readCustomGameMetadata } from "./custom-game-metadata";
import { validateGameFilePath } from "./custom-games";
import type { AppBindings } from "../types";
afterEach(() => vi.unstubAllGlobals());

describe("custom game update metadata", () => {
  it("keeps legacy game edits compatible without making game an unconditional protected path", () => {
    expect(readCustomGameMetadata(new FormData(), null, validateGameFilePath)).toEqual({
      origin: "native", repositoryUrl: "", discordUrl: "", protectedPaths: [], versionLabel: "", trackedReleaseTag: "",
    });
    const form = new FormData(); form.set("origin", "port"); form.set("protectedPaths", '["user","USER"]');
    expect(readCustomGameMetadata(form, null, validateGameFilePath).protectedPaths).toEqual(["USER"]);
    expect(metadataFromRow({ origin: "port", protected_paths_json: "[]" }).protectedPaths).toEqual([]);
  });
  it("preserves metadata on old admin form submissions", () => {
    expect(readCustomGameMetadata(new FormData(), { origin: "port", repository_url: "https://github.com/owner/project",
      discord_url: "https://discord.gg/community", protected_paths_json: '["game","user"]', version_label: "1", tracked_release_tag: "v1" },
    validateGameFilePath)).toMatchObject({ origin: "port", protectedPaths: ["user"], trackedReleaseTag: "v1" });
  });
  it("rejects invalid origins, traversal, unsupported links and credential URLs", () => {
    const form = new FormData(); form.set("origin", "other");
    expect(() => readCustomGameMetadata(form, null, validateGameFilePath)).toThrow();
    form.set("origin", "native"); form.set("protectedPaths", '["../game"]');
    expect(() => readCustomGameMetadata(form, null, validateGameFilePath)).toThrow();
    for (const link of ["http://github.com/owner/project", "https://evil.example/owner/project", "https://token@github.com/owner/project", "https://github.com/owner/project/issues"])
      expect(() => normalizeRepositoryUrl(link)).toThrow();
    expect(normalizeRepositoryUrl("https://github.com/owner/project.git/")).toBe("https://github.com/owner/project");
    expect(normalizeDiscordUrl("https://discord.com/invite/test")).toBe("https://discord.com/invite/test");
    expect(() => normalizeDiscordUrl("https://evil.example/invite/test")).toThrow();
  });
  it("uses a cached official release and flags only a known different tag", async () => {
    const cached = { checkedAt: Date.now(), release: { tag: "v2", name: "2", url: "https://github.com/owner/project/releases/tag/v2", publishedAt: "2026-01-01" } };
    const env = { CUSTOM_GAMES: { get: vi.fn(async () => ({ json: async () => cached })) } } as unknown as AppBindings;
    const meta = { origin: "port" as const, repositoryUrl: "https://github.com/owner/project", discordUrl: "", protectedPaths: ["game"], versionLabel: "1", trackedReleaseTag: "v1" };
    expect(await portReleaseStatus(env, meta)).toMatchObject({ upstreamUpdateAvailable: true, upstreamRelease: { tag: "v2" } });
    expect(await portReleaseStatus(env, { ...meta, trackedReleaseTag: "" })).toMatchObject({ upstreamUpdateAvailable: false });
    expect(await portReleaseStatus(env, { ...meta, trackedReleaseTag: "v2" })).toMatchObject({ upstreamUpdateAvailable: false });
  });
  it("accepts canonical GitHub casing and caches the official latest release", async () => {
    let cache: unknown = null;
    const env = { CUSTOM_GAMES: { get: async () => cache ? { json: async () => cache } : null,
      put: async (_key: string, body: string) => { cache = JSON.parse(body); } } } as unknown as AppBindings;
    const request = vi.fn(async () => Response.json({ tag_name: "v2", name: "Version 2", html_url: "https://github.com/Owner/Project/releases/tag/v2", published_at: "2026-01-01T00:00:00Z", draft: false, prerelease: false }));
    vi.stubGlobal("fetch", request);
    const meta = { origin: "port" as const, repositoryUrl: "https://github.com/owner/project", discordUrl: "", protectedPaths: ["game"], versionLabel: "1", trackedReleaseTag: "v1" };
    expect(await portReleaseStatus(env, meta)).toMatchObject({ upstreamUpdateAvailable: true });
    expect(await portReleaseStatus(env, meta)).toMatchObject({ upstreamUpdateAvailable: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("backs off after an upstream failure without breaking the admin catalog", async () => {
    let cache: unknown = null;
    const env = { CUSTOM_GAMES: { get: async () => cache ? { json: async () => cache } : null,
      put: async (_key: string, body: string) => { cache = JSON.parse(body); } } } as unknown as AppBindings;
    const request = vi.fn(async () => new Response(null, { status: 429 })); vi.stubGlobal("fetch", request);
    const meta = { origin: "port" as const, repositoryUrl: "https://github.com/owner/project", discordUrl: "", protectedPaths: ["game"], versionLabel: "1", trackedReleaseTag: "v1" };
    expect(await portReleaseStatus(env, meta)).toMatchObject({ upstreamCheckError: true, upstreamUpdateAvailable: false });
    expect(await portReleaseStatus(env, meta)).toMatchObject({ upstreamCheckError: true }); expect(request).toHaveBeenCalledTimes(1);
  });
});
