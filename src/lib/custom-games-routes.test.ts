import { expect, it } from "vitest";
import worker from "../index";

it("registers the isolated custom-games routes before the API not-found handler", async () => {
  const context = {} as ExecutionContext;
  for (const path of ["/api/custom-games", "/panel-api/custom-games"]) {
    const response = await worker.fetch(new Request(`https://localhost${path}`), {} as Env, context);
    expect(response.status).not.toBe(404);
  }
});
