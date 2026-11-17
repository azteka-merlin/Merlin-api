import { describe, expect, it } from "vitest";
import { validateSortedFolderPaths } from "./custom-games";

const messages = { duplicate: "duplicado", conflict: "conflito" };

describe("folder path conflicts", () => {
  it("detects a parent file even with another path between it and its child", () => {
    expect(() => validateSortedFolderPaths(["a/file", "a-b", "a"], messages)).toThrow("conflito");
  });
  it("rejects duplicates and allows unrelated prefixes", () => {
    expect(() => validateSortedFolderPaths(["x", "x"], messages)).toThrow("duplicado");
    expect(() => validateSortedFolderPaths(["a-b", "a/file", "a.other"], messages)).not.toThrow();
  });
});
