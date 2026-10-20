import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../types";

export type CustomGameMetadata = {
  origin: "native" | "port"; repositoryUrl: string; discordUrl: string;
  protectedPaths: string[]; versionLabel: string; trackedReleaseTag: string;
};
export type MetadataRow = {
  origin?: "native" | "port"; repository_url?: string; discord_url?: string;
  protected_paths_json?: string; version_label?: string; tracked_release_tag?: string;
};
function fail(message: string): never { throw new HTTPException(400, { message }); }
function label(value: unknown, name: string): string {
  const result = String(value || "").trim();
  if (result.length > 128 || /[\x00-\x1f]/.test(result)) fail(`${name} inválida.`);
  return result;
}
export function normalizeRepositoryUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { fail("Informe um repositório HTTPS do GitHub."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/?$/.test(url.pathname))
    fail("Informe um repositório HTTPS do GitHub.");
  const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  if (!path.split("/")[2]) fail("Informe um repositório HTTPS do GitHub.");
  return `https://github.com${path}`;
}
export function normalizeDiscordUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { fail("Link do Discord inválido."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !((url.hostname === "discord.gg" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) ||
        (["discord.com", "www.discord.com"].includes(url.hostname) && /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))))
    fail("Use um convite HTTPS do Discord.");
  return url.href;
}
export function metadataFromRow(row?: MetadataRow | null): CustomGameMetadata {
  let protectedPaths: string[] = [];
  try { const paths = JSON.parse(row?.protected_paths_json || "[]"); if (Array.isArray(paths)) protectedPaths = paths; } catch { /* legacy */ }
  const origin = row?.origin === "port" ? "port" : "native";
  return { origin, repositoryUrl: row?.repository_url || "", discordUrl: row?.discord_url || "",
    protectedPaths: origin === "port" ? [...new Set(["game", ...protectedPaths])] : protectedPaths,
    versionLabel: row?.version_label || "", trackedReleaseTag: row?.tracked_release_tag || "" };
}
export function readCustomGameMetadata(form: FormData, prior: MetadataRow | null | undefined,
  validatePath: (value: unknown) => string): CustomGameMetadata {
  const previous = metadataFromRow(prior);
  const origin = form.has("origin") ? String(form.get("origin")) : previous.origin;
  if (origin !== "native" && origin !== "port") fail("Origem do jogo inválida.");
  let paths: unknown = previous.protectedPaths;
  if (form.has("protectedPaths")) {
    try { paths = JSON.parse(String(form.get("protectedPaths"))); } catch { fail("Caminhos protegidos inválidos."); }
  }
  if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== "string"))
    fail("Informe até 64 caminhos protegidos relativos ao jogo.");
  const protectedPaths = [...new Map(paths.map(path => {
    const normalized = validatePath(path); return [normalized.toLowerCase(), normalized];
  })).values()];
  if (origin === "port" && !protectedPaths.some(path => path.toLowerCase() === "game")) protectedPaths.unshift("game");
  return { origin, protectedPaths,
    repositoryUrl: origin === "port" ? normalizeRepositoryUrl(form.has("repositoryUrl") ? form.get("repositoryUrl") : previous.repositoryUrl) : "",
    discordUrl: origin === "port" ? normalizeDiscordUrl(form.has("discordUrl") ? form.get("discordUrl") : previous.discordUrl) : "",
    versionLabel: label(form.has("versionLabel") ? form.get("versionLabel") : previous.versionLabel, "Versão"),
    trackedReleaseTag: origin === "port" ? label(form.has("trackedReleaseTag") ? form.get("trackedReleaseTag") : previous.trackedReleaseTag, "Tag") : "" };
}

type UpstreamRelease = { tag: string; name: string; url: string; publishedAt: string };
type ReleaseCache = { checkedAt: number; release: UpstreamRelease | null; etag?: string; errorUntil?: number };
export async function portReleaseStatus(env: AppBindings, metadata: CustomGameMetadata) {
  if (metadata.origin !== "port" || !metadata.repositoryUrl) return {};
  const repository = normalizeRepositoryUrl(metadata.repositoryUrl).slice("https://github.com/".length);
  const key = `_port-releases/${repository.toLowerCase()}.json`;
  let cached: ReleaseCache | null = null;
  try { cached = await (await env.CUSTOM_GAMES.get(key))?.json<ReleaseCache>() || null; } catch { /* retry safely */ }
  if (cached?.errorUntil && cached.errorUntil > Date.now()) return {
    ...(cached.release ? { upstreamRelease: cached.release } : {}), upstreamUpdateAvailable: false, upstreamCheckError: true,
  };
  if (!cached || cached.checkedAt < Date.now() - 3600_000) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "Merlin-port-release-monitor",
          "x-github-api-version": "2026-03-10", ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          ...(env.CUSTOM_GAME_GITHUB_TOKEN ? { authorization: `Bearer ${env.CUSTOM_GAME_GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (response.status === 304 && cached) cached = { ...cached, checkedAt: Date.now() };
      else if (response.status === 404) cached = { checkedAt: Date.now(), release: null };
      else {
        if (!response.ok) throw new Error("upstream_unavailable");
        const release = await response.json<{ tag_name?: string; name?: string; html_url?: string; published_at?: string; draft?: boolean; prerelease?: boolean }>();
        if (!release.tag_name || release.draft || release.prerelease ||
            !release.html_url?.toLowerCase().startsWith(`https://github.com/${repository.toLowerCase()}/releases/`) || !release.published_at)
          throw new Error("invalid_release");
        cached = { checkedAt: Date.now(), etag: response.headers.get("etag") || undefined,
          release: { tag: release.tag_name.slice(0, 128), name: (release.name || release.tag_name).slice(0, 200),
            url: release.html_url, publishedAt: release.published_at } };
      }
      await env.CUSTOM_GAMES.put(key, JSON.stringify(cached), { httpMetadata: { contentType: "application/json" } });
    } catch {
      const backoff = { ...(cached || { checkedAt: 0, release: null }), errorUntil: Date.now() + 300_000 };
      await env.CUSTOM_GAMES.put(key, JSON.stringify(backoff), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
      return { ...(cached?.release ? { upstreamRelease: cached.release } : {}), upstreamUpdateAvailable: false,
        upstreamCheckError: true };
    }
  }
  return { ...(cached?.release ? { upstreamRelease: cached.release } : {}),
    upstreamUpdateAvailable: Boolean(cached?.release && metadata.trackedReleaseTag && cached.release.tag !== metadata.trackedReleaseTag) };
}
