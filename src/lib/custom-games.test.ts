import { describe, expect, it } from "vitest";
import { belongsToGame, readGameForm, validFolderFileCount, validateExecutable, validateGameFilePath, validateInstallName, validateSha256, type GameRow } from "./custom-games";
import type { AppContext } from "../types";

describe("custom game install contracts", () => {
  it("groups new objects under their game without rejecting legacy keys", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    expect(belongsToGame(`${id}/archives/${other}.zip`, id)).toBe(true);
    expect(belongsToGame(`${other}/archives/${id}.zip`, id)).toBe(false);
    expect(belongsToGame(`archives/${other}.zip`, id)).toBe(true);
  });
  it("accepts up to 100,000 folder files and rejects larger manifests", () => {
    expect(validFolderFileCount([])).toBe(false);
    expect(validFolderFileCount(new Array(11_000))).toBe(true);
    expect(validFolderFileCount(new Array(20_000))).toBe(true);
    expect(validFolderFileCount(new Array(30_000))).toBe(true);
    expect(validFolderFileCount(new Array(100_000))).toBe(true);
    expect(validFolderFileCount(new Array(100_001))).toBe(false);
  });
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

  it("saves an empty draft, but requires a name and package to publish", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const context = (form: FormData) => ({ req: { formData: async () => form }, env: {} }) as unknown as AppContext;
    const draft = await readGameForm(context(new FormData()), id);
    expect(draft).toMatchObject({ name: "", installName: `draft-${id}`, archiveKey: `draft/${id}`,
      archiveSize: 0, imageKey: "", published: 0 });
    const namedDraft = new FormData();
    namedDraft.set("name", "CON");
    expect((await readGameForm(context(namedDraft), id)).installName).toBe(`draft-${id}`);
    const unnamed = new FormData();
    unnamed.set("published", "true");
    await expect(readGameForm(context(unnamed), id)).rejects.toThrow("Informe um nome");
    const missingPackage = new FormData();
    missingPackage.set("name", "Jogo completo depois");
    missingPackage.set("published", "true");
    await expect(readGameForm(context(missingPackage), id)).rejects.toThrow("Envie o pacote");
    missingPackage.set("archiveKey", "archives/00000000-0000-4000-8000-000000000002.zip");
    const withPackage = { req: { formData: async () => missingPackage }, env: {
      CUSTOM_GAMES: { head: async () => ({ size: 123, etag: "test-etag" }), get: async () => null },
    } } as unknown as AppContext;
    // Existing unscoped legacy packages remain editable in their own game.
    await expect(readGameForm(withPackage, id, { archive_key: String(missingPackage.get("archiveKey")), image_key: "" } as GameRow))
      .rejects.toThrow("ainda está sendo indexado");
    missingPackage.set("archiveKey", `${id}/archives/00000000-0000-4000-8000-000000000002.zip`);
    await expect(readGameForm(withPackage, id)).rejects.toThrow("ainda está sendo indexado");
    missingPackage.set("archiveKey", "00000000-0000-4000-8000-000000000002/archives/00000000-0000-4000-8000-000000000002.zip");
    await expect(readGameForm(withPackage, id)).rejects.toThrow("pertence a outro jogo");
  });
  it("rejects attaching an unowned legacy package to a different game", async () => {
    const form = new FormData(); form.set("archiveKey", "archives/00000000-0000-4000-8000-000000000002.zip");
    const c = { req: { formData: async () => form }, env: { merlin_db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } } as unknown as AppContext;
    await expect(readGameForm(c, "00000000-0000-4000-8000-000000000001")).rejects.toThrow("pacote legado não pertence");
  });
});
