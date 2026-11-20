import { routePath } from "hono/route";
import type { AppContext } from "../types";

export function safeErrorText(text: string) {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "$1=[redacted]")
    .replace(/\b(password|(?:client[_-]?)?secret|(?:api|license)[_-]?key|(?:(?:access|refresh|session)[_-]?)?token|signature)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;)}]+)/gi, "$1=[redacted]")
    .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}|\b(?:MERLIN-[a-z0-9-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|(?:cfut|sk|rk|whsec|ghp|github_pat)_[\w-]+|[a-f0-9]{16,}|\d{4,})\b/gi, "[redacted]");
}

export function logApiError(c: AppContext, error: Error, status: number) {
  const code = (error as { code?: unknown }).code;
  const ray = c.req.header("cf-ray");
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const stack = error.stack?.split(/\r?\n/).filter(line => /^\s*at /.test(line)).slice(0, 10).join("\n");
  console.error({
    event: "merlin_api_error",
    method: c.req.method,
    route: routePath(c) || routePath(c, -1),
    status,
    rayId: ray && /^[0-9a-f]{16}(?:-[a-z]{3})?$/i.test(ray) ? ray : undefined,
    errorName: safeErrorText(error.name).slice(0, 80),
    errorCode: typeof code === "string" ? safeErrorText(code).slice(0, 80) : undefined,
    errorMessage: safeErrorText(error.message).slice(0, 500),
    causeName: cause ? safeErrorText(cause.name).slice(0, 80) : undefined,
    causeMessage: cause ? safeErrorText(cause.message).slice(0, 500) : undefined,
    stack: stack ? safeErrorText(stack).slice(0, 1400) : undefined,
  });
}
