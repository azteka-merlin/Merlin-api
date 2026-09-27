const LICENSE_HEADER_BYTES = 0x41;
const MAX_TOKEN_LENGTH = 16 * 1024;

export const MAX_LICENSE_FILE_BYTES = 1024 * 1024;

export type LicenseTokenErrorCode =
	| "invalid_decryption_key"
	| "invalid_license_file"
	| "license_token_not_found";

export class LicenseTokenError extends Error {
	readonly code: LicenseTokenErrorCode;

	constructor(code: LicenseTokenErrorCode) {
		super(code);
		this.name = "LicenseTokenError";
		this.code = code;
	}
}

function decodeBase64Key(value: string): Uint8Array {
	try {
		const normalized = value.trim();
		if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
			throw new Error("invalid base64");
		}

		const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
		if (![16, 24, 32].includes(bytes.byteLength)) {
			throw new Error("invalid AES key length");
		}
		return bytes;
	} catch {
		throw new LicenseTokenError("invalid_decryption_key");
	}
}

function extractGameToken(xml: string): string | null {
	const match = xml.match(/<GameToken(?:\s[^>]*)?>([\s\S]*?)<\/GameToken\s*>/i);
	const token = match?.[1]?.trim() || "";
	if (!token || token.length > MAX_TOKEN_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(token)) {
		return null;
	}
	return token;
}

async function decryptCandidate(ciphertext: Uint8Array, key: CryptoKey): Promise<string> {
	if (ciphertext.byteLength === 0 || ciphertext.byteLength % 16 !== 0) {
		throw new Error("invalid AES-CBC ciphertext length");
	}

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-CBC", iv: new Uint8Array(16) },
		key,
		ciphertext,
	);
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decrypted);
}

export async function extractTokenFromLicenseFile(
	licenseBytes: Uint8Array,
	decryptionKeyBase64: string,
): Promise<string> {
	if (licenseBytes.byteLength === 0 || licenseBytes.byteLength > MAX_LICENSE_FILE_BYTES) {
		throw new LicenseTokenError("invalid_license_file");
	}

	const rawKey = decodeBase64Key(decryptionKeyBase64);
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
	} catch {
		throw new LicenseTokenError("invalid_decryption_key");
	}

	const candidates = [licenseBytes];
	if (licenseBytes.byteLength > LICENSE_HEADER_BYTES) {
		candidates.push(licenseBytes.slice(LICENSE_HEADER_BYTES));
	}

	let decryptedAnyCandidate = false;
	for (const candidate of candidates) {
		try {
			const xml = await decryptCandidate(candidate, key);
			decryptedAnyCandidate = true;
			const token = extractGameToken(xml);
			if (token) return token;
		} catch {
			// Some license files contain a 65-byte signature before the ciphertext.
		}
	}

	throw new LicenseTokenError(decryptedAnyCandidate ? "license_token_not_found" : "invalid_license_file");
}
