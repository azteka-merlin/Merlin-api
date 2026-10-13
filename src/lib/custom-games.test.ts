import { describe, expect, it } from "vitest";
import { validateExecutable, validateGameFilePath, validateInstallName, validateSha256 } from "./custom-games";

describe("custom game install contracts", () => {
  it("keeps a recognizable fixed Games folder name without Windows separators", () => {
    expect(validateInstallName("The Adventures of Elliot")).toBe("The Adventures of Elliot");
    expect(validateInstallName("Alan Wake: 2 / Edition")).toBe("Alan Wake 2 Edition");
    expect(() => validateInstallName("CON")).toThrow();
  });

  it("keeps Play optional and rejects absolute, traversal or non-exe paths", () => {
    expect(validateExecutable(" ")).toBeNull();
    expect(validateExecutable("Game\\Binaries\\Game.exe")).toBe("Game/Binaries/Game.exe");
    for (const value of ["../Game.exe", "C:\\Game.exe", "/Game.exe", "setup.bat", "Game//Game.exe"]) {
      expect(() => validateExecutable(value)).toThrow();
    }
  });

  it("accepts safe relative folder paths and rejects Windows path escapes and collisions", () => {
    expect(validateGameFilePath("data_pack2/pc/stream0.rmdblob")).toBe("data_pack2/pc/stream0.rmdblob");
    expect(validateGameFilePath("Data\\Game.exe")).toBe("Data/Game.exe");
    for (const value of ["../outside", "C:\\Windows\\file", "/absolute", "Game/file:stream", "CON.txt", ".merlin-install.json", "Data/.merlin-install.json"]) {
      expect(() => validateGameFilePath(value)).toThrow();
    }
  });

  it("accepts only canonical 32-byte SHA-256 checksums", () => {
    const checksum = "a".repeat(64);
    expect(validateSha256(checksum)).toBe(checksum);
    expect(validateSha256("A".repeat(64))).toBe(checksum);
    for (const value of ["", "a".repeat(63), "g".repeat(64), "a".repeat(65)]) {
      expect(() => validateSha256(value)).toThrow();
    }
  });
});
