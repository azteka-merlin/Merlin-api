import { expect, it } from "vitest";
import worker from "../index";

it("registers the isolated custom-games routes before the API not-found handler", async () => {
  const context = {} as ExecutionContext;
  for (const [method, path] of [
    ["GET", "/api/custom-games"], ["GET", "/panel-api/custom-games"],
    ["POST", "/panel-api/custom-games/upload/file"], ["POST", "/panel-api/custom-games/upload/folder/complete"],
    ["GET", "/api/custom-games/00000000-0000-4000-8000-000000000000/manifest"],
    ["GET", "/api/custom-games/00000000-0000-4000-8000-000000000000/files/00000000-0000-4000-8000-000000000001"],
  ]) {
    const response = await worker.fetch(new Request(`https://localhost${path}`, { method }), {} as Env, context);
    expect(response.status).not.toBe(404);
  }
});
