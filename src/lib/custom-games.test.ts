import { describe, expect, it } from "vitest";
import { validateExecutable, validateInstallName } from "./custom-games";

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
});
