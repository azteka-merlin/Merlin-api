import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import type { LicenseRecord } from "./licenses";

type RecoveryPinHashInput = {
	licenseKey: string;
	recoveryPin: string;
};

type LegacyRecoveryPinHashInput = {
	contact: string;
	contactType: LicenseRecord["contact_type"];
	recoveryPin: string;
};

const RECOVERY_SECRET_PATTERN = /^\S{4,8}$/;

export const RECOVERY_SECRET_DESCRIPTION = "Use 4 a 8 caracteres, sem espacos. PINs numericos antigos continuam funcionando.";

export function isValidRecoverySecret(value: string) {
	return RECOVERY_SECRET_PATTERN.test(value);
}

async function sha256Hex(value: string) {
	const data = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getRecoveryPinSecret(c: AppContext) {
	const secret = String(c.env.SESSION_HASH_SECRET || "").trim();
	if (!secret) {
		throw new HTTPException(500, { message: "SESSION_HASH_SECRET is not configured" });
	}
	return secret;
}

export function normalizeRecoveryPin(value?: string | null) {
	const recoveryPin = String(value || "").trim();
	if (!recoveryPin) return null;
	if (!isValidRecoverySecret(recoveryPin)) {
		throw new HTTPException(400, { message: RECOVERY_SECRET_DESCRIPTION });
	}
	return recoveryPin;
}

export async function hashRecoveryPin(c: AppContext, input: RecoveryPinHashInput) {
	return sha256Hex(`${getRecoveryPinSecret(c)}:license:${input.licenseKey}:${input.recoveryPin}`);
}

async function hashLegacyRecoveryPin(c: AppContext, input: LegacyRecoveryPinHashInput) {
	return sha256Hex(`${getRecoveryPinSecret(c)}:${input.contactType}:${input.contact}:${input.recoveryPin}`);
}

export async function compareRecoveryPin(c: AppContext, license: LicenseRecord, recoveryPin: string) {
	if (!license.recovery_pin_hash) {
		return false;
	}

	const expected = await hashRecoveryPin(c, {
		licenseKey: license.license_key,
		recoveryPin,
	});
	if (expected === license.recovery_pin_hash) {
		return true;
	}

	const legacyExpected = await hashLegacyRecoveryPin(c, {
		contact: license.contact,
		contactType: license.contact_type,
		recoveryPin,
	});
	return legacyExpected === license.recovery_pin_hash;
}
