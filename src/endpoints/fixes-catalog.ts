import { OpenAPIRoute } from "chanfana";
import { verifyAccessToken } from "../lib/auth";
import { listCorrectionVoteTotals, listViewerVotes } from "../lib/correction-votes";
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

type ViewerLicenseLookup = {
  id: number;
  hwid: string | null;
  expires_at: string;
  status: "active" | "revoked";
};

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

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

function normalizeRemoteEntries(entries: unknown): Array<{ appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string; adminNote?: string }> }> {
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
    .filter((entry): entry is { appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string; adminNote?: string }> } => Boolean(entry));
}

function buildDownloadHref(request: Request, appId: string): string {
  const url = new URL(request.url);
  url.pathname = "/api/fixes/download";
  url.search = "";
  url.searchParams.set("appid", appId);
  return url.toString();
}

async function getViewerLicenseId(c: AppContext): Promise<number | null> {
  const accessToken = parseBearerToken(c.req.raw);
  if (!accessToken || !c.env.JWT_SECRET) return null;

  try {
    const tokenPayload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
    if (tokenPayload.exp <= Math.floor(Date.now() / 1000)) return null;

    const license = await c.env.merlin_db
      .prepare(
        `SELECT id, hwid, expires_at, status
         FROM licenses
         WHERE id = ?`,
      )
      .bind(tokenPayload.sub)
      .first<ViewerLicenseLookup>();

    if (!license || license.status !== "active") return null;
    if (!license.hwid || license.hwid !== tokenPayload.hwid) return null;

    const expiresAt = new Date(license.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return null;
    }

    return license.id;
  } catch {
    return null;
  }
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

    let remoteEntries: Array<{ appid: string; name: string; fixes: Array<{ href: string; filename: string; size?: string; adminNote?: string }> }> = [];
    if (remoteResponse.ok) {
      remoteEntries = normalizeRemoteEntries(await remoteResponse.json());
    } else {
      console.warn("[fixes] remote catalog returned HTTP", remoteResponse.status);
    }

    const overrides = await readOverrides(c.env);
    const byAppId = new Map(remoteEntries.map((entry) => [entry.appid, entry]));

    for (const [appId, entry] of Object.entries(overrides)) {
      const fixOverride = entry.fixOverride;
      const overrideName = entry.name || fixOverride?.gameName || undefined;
      const overrideAdminNote = entry.adminNote || undefined;
      const existing = byAppId.get(appId);

      if (fixOverride?.enabled) {
        const nextFix = {
          href: buildDownloadHref(c.req.raw, appId),
          filename: fixOverride.filename || `${appId}${fixOverride.file.endsWith(".rar") ? ".rar" : ".zip"}`,
          size: fixOverride.size || undefined,
          adminNote: overrideAdminNote,
        };

        if (existing) {
          byAppId.set(appId, {
            ...existing,
            name: overrideName || existing.name,
            fixes: [nextFix],
          });
          continue;
        }

        if (!overrideName) {
          console.warn("[fixes] skipping override-only catalog item without name", { appId });
          continue;
        }

        byAppId.set(appId, {
          appid: appId,
          name: overrideName,
          fixes: [nextFix],
        });
        continue;
      }

      if (!existing || (!overrideName && !overrideAdminNote)) continue;

      byAppId.set(appId, {
        ...existing,
        name: overrideName || existing.name,
        fixes: existing.fixes.map((fix) => ({
          ...fix,
          adminNote: overrideAdminNote || fix.adminNote,
        })),
      });
    }
    const appIds = [...byAppId.keys()];
    const [voteTotals, viewerLicenseId] = await Promise.all([
      listCorrectionVoteTotals(c.env, appIds),
      getViewerLicenseId(c),
    ]);
    const viewerVotes = viewerLicenseId
      ? await listViewerVotes(c.env, viewerLicenseId, appIds)
      : new Map<string, "up" | "down">();

    const items = [...byAppId.values()]
      .map((entry) => {
        const totals = voteTotals.get(entry.appid) || { upvotes: 0, downvotes: 0, score: 0 };
        const viewerVote = viewerVotes.get(entry.appid) || undefined;
        return {
          ...entry,
          fixes: entry.fixes.map((fix) => ({
            ...fix,
            upvotes: totals.upvotes,
            downvotes: totals.downvotes,
            score: totals.score,
            viewerVote,
          })),
        };
      })
      .sort((left, right) => {
        const leftFix = left.fixes[0];
        const rightFix = right.fixes[0];
        const scoreDelta = Number(rightFix?.score || 0) - Number(leftFix?.score || 0);
        if (scoreDelta !== 0) return scoreDelta;
        const upvotesDelta = Number(rightFix?.upvotes || 0) - Number(leftFix?.upvotes || 0);
        if (upvotesDelta !== 0) return upvotesDelta;
        return left.name.localeCompare(right.name);
      });

    if (!items.length && !remoteResponse.ok) {
      return c.json({ error: "Could not load the fixes catalog" }, 502);
    }

    return c.json(items, 200);
  }
}

