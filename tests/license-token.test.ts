import { describe, expect, test } from "vitest";
import {
  extractTokenFromLicenseFile,
  LicenseTokenError,
  MAX_LICENSE_FILE_BYTES,
} from "../src/lib/license-token";

const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const keyBase64 = Buffer.from(keyBytes).toString("base64");

async function encryptLicense(xml: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) },
    key,
    new TextEncoder().encode(xml),
  );
  return new Uint8Array(encrypted);
}

describe("license file token extraction", () => {
  test("decrypts a license and returns GameToken", async () => {
    const encrypted = await encryptLicense("<License><GameToken>token-for-test</GameToken></License>");

    await expect(extractTokenFromLicenseFile(encrypted, keyBase64)).resolves.toBe("token-for-test");
  });

  test("supports a 65-byte signature before the encrypted payload", async () => {
    const encrypted = await encryptLicense("<License><GameToken>signed-token</GameToken></License>");
    const file = new Uint8Array(65 + encrypted.byteLength);
    file.fill(7, 0, 65);
    file.set(encrypted, 65);

    await expect(extractTokenFromLicenseFile(file, keyBase64)).resolves.toBe("signed-token");
  });

  test("rejects decrypted licenses without a token", async () => {
    const encrypted = await encryptLicense("<License><CipherKey>value</CipherKey></License>");

    await expect(extractTokenFromLicenseFile(encrypted, keyBase64)).rejects.toMatchObject<Partial<LicenseTokenError>>({
      code: "license_token_not_found",
    });
  });

  test("rejects invalid keys and oversized files", async () => {
    await expect(extractTokenFromLicenseFile(new Uint8Array(16), "invalid"))
      .rejects.toMatchObject<Partial<LicenseTokenError>>({ code: "invalid_decryption_key" });
    await expect(extractTokenFromLicenseFile(new Uint8Array(MAX_LICENSE_FILE_BYTES + 1), keyBase64))
      .rejects.toMatchObject<Partial<LicenseTokenError>>({ code: "invalid_license_file" });
  });
});
