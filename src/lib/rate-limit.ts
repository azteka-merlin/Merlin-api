import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

type RateLimitBinding = {
	limit(input: { key: string }): Promise<{ success: boolean }>;
};

type RateLimitBindings = {
	LOGIN_RATE_LIMITER?: RateLimitBinding;
	MANIFESTS_RATE_LIMITER?: RateLimitBinding;
	ADMIN_RATE_LIMITER?: RateLimitBinding;
};

type LoginRateLimitInput = {
	licenseKey: string;
	hwid: string;
};

const LOGIN_LIMIT_MESSAGE =
	"O limite temporario de tentativas de acesso foi atingido. Aguarde aproximadamente 1 minuto e tente novamente.";
const MANIFESTS_LIMIT_MESSAGE =
	"O limite temporario de solicitacoes desta licenca foi atingido. Aguarde alguns instantes e tente novamente.";
const ADMIN_LIMIT_MESSAGE =
	"O limite temporario de solicitacoes administrativas foi atingido. Aguarde alguns instantes e tente novamente.";

function getRateLimiter(binding: RateLimitBinding | undefined, name: string): RateLimitBinding {
	if (!binding) {
		throw new HTTPException(500, { message: `${name} is not configured` });
	}
	return binding;
}

async function enforceLimit(
	binding: RateLimitBinding | undefined,
	key: string,
	message: string,
	logLabel: string,
) {
	const limiter = getRateLimiter(binding, logLabel);
	const { success } = await limiter.limit({ key });
	if (success) return;

	console.warn(`[rate-limit] ${logLabel} exceeded`);
	throw new HTTPException(429, { message });
}

function getClientIp(c: AppContext): string | null {
	const headers = c.req.raw.headers;
	const connectingIp = headers.get("cf-connecting-ip")?.trim();
	if (connectingIp) return connectingIp;

	const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	if (forwardedFor) return forwardedFor;

	const realIp = headers.get("x-real-ip")?.trim();
	return realIp || null;
}

export async function enforceLoginRateLimit(c: AppContext, input: LoginRateLimitInput) {
	const env = c.env as typeof c.env & RateLimitBindings;
	const clientIp = getClientIp(c);
	const normalizedLicense = input.licenseKey.trim().toUpperCase();
	const normalizedHwid = input.hwid.trim().toLowerCase();
	const keys = [
		clientIp ? `login:ip:${clientIp}` : null,
		`login:hwid:${normalizedHwid}`,
		`login:key:${normalizedLicense}`,
	].filter((key): key is string => Boolean(key));

	for (const key of keys) {
		await enforceLimit(env.LOGIN_RATE_LIMITER, key, LOGIN_LIMIT_MESSAGE, "login");
	}
}

export async function enforceManifestsRateLimit(c: AppContext, licenseId: number) {
	const env = c.env as typeof c.env & RateLimitBindings;
	await enforceLimit(
		env.MANIFESTS_RATE_LIMITER,
		`license:${licenseId}`,
		MANIFESTS_LIMIT_MESSAGE,
		"manifests",
	);
}

export async function enforceAdminRateLimit(c: AppContext, adminKey: string) {
	const env = c.env as typeof c.env & RateLimitBindings;
	await enforceLimit(env.ADMIN_RATE_LIMITER, adminKey, ADMIN_LIMIT_MESSAGE, "admin");
}
