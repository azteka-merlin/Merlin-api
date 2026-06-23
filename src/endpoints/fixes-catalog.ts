import { OpenAPIRoute } from "chanfana";
import { readOverrides } from "../lib/overrides";
import type { AppContext } from "../types";

const DEFAULT_FIXES_URL = "https://generator.ryuu.lol/files/fixes.json";

type RemoteFix = {
	href?: string;
	filename?: string;
	size?: string;
	badges?: unknown[];
};

type RemoteEntry = {
	appid?: string | number;
	name?: string;
	fixes?: RemoteFix[];
};

function firstEligibleCorrection(fixes: unknown): { href: string; filename: string; size?: string } | null {
	if (!Array.isArray(fixes)) return null;

	for (const fix of fixes) {
		if (!fix || typeof fix !== "object" || Array.isArray(fix)) continue;
		const candidate = fix as RemoteFix;
		const badges = Array.isArray(candidate.badges)
			? candidate.badges.map((value) => String(value || "").trim().toLocaleLowerCase())
			: [];
		if (badges.includes("hypervisor")) continue;

		const href = typeof candidate.href === "string" ? candidate.href.trim() : "";
		const filename = typeof candidate.filename === "string" ? candidate.filename.trim() : "";
		const size = typeof candidate.size === "string" ? candidate.size.trim() : "";
		if (!href || !filename) continue;

		return { href, filename, size: size || undefined };
	}

	return null;
}

function normalizeRemoteEntries(entries: unknown): Array<{ appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string }> }> {
	if (!Array.isArray(entries)) {
		throw new Error("Invalid fixes catalog payload");
	}

	return entries
		.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
			const candidate = entry as RemoteEntry;
			const appid = String(candidate.appid || "").trim();
			const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
			if (!/^\d+$/.test(appid) || !name) return null;

			const fix = firstEligibleCorrection(candidate.fixes);
			if (!fix) return null;

			return {
				appid,
				name,
				fixes: [fix],
			};
		})
		.filter((entry): entry is { appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string }> } => Boolean(entry));
}

function buildDownloadHref(request: Request, appId: string): string {
	const url = new URL(request.url);
	url.pathname = "/api/fixes/download";
	url.search = "";
	url.searchParams.set("appid", appId);
	return url.toString();
}

export class FixesCatalogRoute extends OpenAPIRoute {
	schema = {
		tags: ["Fixes"],
		summary: "List community corrections with optional R2 overrides",
		responses: {
			"200": {
				description: "Returns the fixes catalog",
			},
			"502": {
				description: "Could not load the fixes catalog",
			},
		},
	};

	async handle(c: AppContext) {
		const remoteResponse = await fetch(DEFAULT_FIXES_URL, {
			headers: {
				"User-Agent": "Merlin/2.0",
				Accept: "application/json",
			},
		});

		let remoteEntries: Array<{ appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string }> }> = [];
		if (remoteResponse.ok) {
			remoteEntries = normalizeRemoteEntries(await remoteResponse.json());
		} else {
			console.warn("[fixes] remote catalog returned HTTP", remoteResponse.status);
		}

		const overrides = await readOverrides(c.env);
		const byAppId = new Map(remoteEntries.map((entry) => [entry.appid, entry]));

		for (const [appId, entry] of Object.entries(overrides)) {
			const fixOverride = entry.fixOverride;
			if (!fixOverride?.enabled) continue;

			const nextFix = {
				href: buildDownloadHref(c.req.raw, appId),
				filename: fixOverride.filename || `${appId}${fixOverride.file.endsWith(".rar") ? ".rar" : ".zip"}`,
				size: fixOverride.size || undefined,
			};

			const existing = byAppId.get(appId);
			if (existing) {
				byAppId.set(appId, {
					...existing,
					fixes: [nextFix],
				});
				continue;
			}

			if (!fixOverride.gameName) {
				console.warn("[fixes] skipping override-only catalog item without gameName", { appId });
				continue;
			}

			byAppId.set(appId, {
				appid: appId,
				name: fixOverride.gameName,
				fixes: [nextFix],
			});
		}

		const items = [...byAppId.values()].sort((left, right) => left.name.localeCompare(right.name));
		if (!items.length && !remoteResponse.ok) {
			return c.json({ error: "Could not load the fixes catalog" }, 502);
		}

		return c.json(items, 200);
	}
}
