import { HTTPException } from "hono/http-exception";

export type CustomGameMetadata = {
  origin: "native" | "port";
  protectedPaths: string[];
};

export type MetadataRow = {
  origin?: "native" | "port";
  protected_paths_json?: string;
};

function fail(message: string): never { throw new HTTPException(400, { message }); }

export function metadataFromRow(row?: MetadataRow | null): CustomGameMetadata {
  let protectedPaths: string[] = [];
  try { const paths = JSON.parse(row?.protected_paths_json || "[]"); if (Array.isArray(paths)) protectedPaths = paths; } catch { /* legacy */ }
  const origin = row?.origin === "port" ? "port" : "native";
  return { origin, protectedPaths: origin === "port"
    ? protectedPaths.filter(path => typeof path === "string" && path.toLowerCase() !== "game") : protectedPaths };
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
  })).values()].filter(path => origin !== "port" || path.toLowerCase() !== "game");
  return { origin, protectedPaths };
}
