import { HTTPException } from "hono/http-exception";

export type AccessTokenPayload = {
	sub: number;
	hwid: string;
	type: "access";
	exp: number;
	jti: string;
};

const encoder = new TextEncoder();

function toBase64Url(input: ArrayBuffer | string): string {
	const bytes =
		typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);

	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): string {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
	return atob(`${normalized}${padding}`);
}

async function importJwtKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signAccessToken(
	payload: AccessTokenPayload,
	secret: string,
): Promise<string> {
	const header = {
		alg: "HS256",
		typ: "JWT",
	};

	const encodedHeader = toBase64Url(JSON.stringify(header));
	const encodedPayload = toBase64Url(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const key = await importJwtKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));

	return `${signingInput}.${toBase64Url(signature)}`;
}

export async function verifyAccessToken(
	token: string,
	secret: string,
): Promise<AccessTokenPayload> {
	const parts = token.split(".");

	if (parts.length !== 3) {
		throw new HTTPException(401, { message: "Invalid access token" });
	}

	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const key = await importJwtKey(secret);
	const signature = Uint8Array.from(fromBase64Url(encodedSignature), (char) => char.charCodeAt(0));
	const isValid = await crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		encoder.encode(signingInput),
	);

	if (!isValid) {
		throw new HTTPException(401, { message: "Invalid access token" });
	}

	try {
		const payload = JSON.parse(fromBase64Url(encodedPayload)) as AccessTokenPayload;

		if (
			typeof payload.sub !== "number" ||
			typeof payload.hwid !== "string" ||
			payload.type !== "access" ||
			typeof payload.exp !== "number" ||
			typeof payload.jti !== "string"
		) {
			throw new Error("Invalid token payload");
		}

		return payload;
	} catch {
		throw new HTTPException(401, { message: "Invalid access token" });
	}
}
