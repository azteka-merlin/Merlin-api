export const SPECIAL_CORRECTION_APP_ID = "4407750";
export const SPECIAL_CORRECTION_ACTIVATION_TYPE = "license_token";
export const SPECIAL_CORRECTION_MINIMUM_VERSION = "1.6.8";

function parseVersion(value: string | null | undefined): [number, number, number] | null {
	const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsSpecialCorrection(value: string | null | undefined): boolean {
	const current = parseVersion(value);
	const minimum = parseVersion(SPECIAL_CORRECTION_MINIMUM_VERSION);
	if (!current || !minimum) return false;

	for (let index = 0; index < minimum.length; index += 1) {
		const currentPart = current[index] ?? 0;
		const minimumPart = minimum[index] ?? 0;
		if (currentPart > minimumPart) return true;
		if (currentPart < minimumPart) return false;
	}
	return true;
}

export function specialCorrectionMetadata(appId: string) {
	return appId === SPECIAL_CORRECTION_APP_ID
		? {
			activationType: SPECIAL_CORRECTION_ACTIVATION_TYPE,
			minimumLauncherVersion: SPECIAL_CORRECTION_MINIMUM_VERSION,
		}
		: {};
}
