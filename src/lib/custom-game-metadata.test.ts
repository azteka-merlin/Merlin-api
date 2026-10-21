import { describe, expect, it } from "vitest";
import { metadataFromRow, readCustomGameMetadata } from "./custom-game-metadata";
import { validateGameFilePath } from "./custom-games";

describe("custom game update metadata", () => {
  it("keeps legacy edits compatible without protecting game unconditionally", () => {
    expect(readCustomGameMetadata(new FormData(), null, validateGameFilePath)).toEqual({ origin: "native", protectedPaths: [] });
    const form = new FormData(); form.set("origin", "port"); form.set("protectedPaths", '["game","user","USER"]');
    expect(readCustomGameMetadata(form, null, validateGameFilePath)).toEqual({ origin: "port", protectedPaths: ["USER"] });
  });

  it("preserves origin and paths on old admin submissions", () => {
    expect(readCustomGameMetadata(new FormData(), { origin: "port", protected_paths_json: '["game","user"]' },
      validateGameFilePath)).toEqual({ origin: "port", protectedPaths: ["user"] });
  });

  it("rejects invalid origin and paths", () => {
    const badOrigin = new FormData(); badOrigin.set("origin", "other");
    expect(() => readCustomGameMetadata(badOrigin, null, validateGameFilePath)).toThrow();
    const badPath = new FormData(); badPath.set("protectedPaths", '["../escape"]');
    expect(() => readCustomGameMetadata(badPath, null, validateGameFilePath)).toThrow();
  });

  it("ignores obsolete release fields from an older admin page", () => {
    const form = new FormData(); form.set("repositoryUrl", "https://github.com/owner/project");
    form.set("discordUrl", "https://discord.gg/example"); form.set("versionLabel", "v1");
    form.set("trackedReleaseTag", "v1");
    expect(readCustomGameMetadata(form, null, validateGameFilePath)).toEqual({ origin: "native", protectedPaths: [] });
    expect(metadataFromRow({ origin: "port", protected_paths_json: '["user"]' })).toEqual({ origin: "port", protectedPaths: ["user"] });
  });
});
