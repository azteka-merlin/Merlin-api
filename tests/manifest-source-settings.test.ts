import { describe, expect, test } from "vitest";
import { manifestPrimarySourceOrder } from "../src/lib/manifest-source-settings";

describe("manifest source priority", () => {
  test("defaults to Hubcap, followed by Ryuu", () => {
    expect(manifestPrimarySourceOrder(undefined)).toEqual(["hubcap", "ryuu", "depotbox", "steam-api"]);
    expect(manifestPrimarySourceOrder("hubcap")).toEqual(["hubcap", "ryuu", "depotbox", "steam-api"]);
  });
  test.each([
    ["depotbox", ["depotbox", "hubcap", "ryuu", "steam-api"]],
    ["ryuu", ["ryuu", "hubcap", "depotbox", "steam-api"]],
    ["steam-api", ["steam-api", "hubcap", "ryuu", "depotbox"]],
  ])("moves %s first", (source, order) => {
    expect(manifestPrimarySourceOrder(source)).toEqual(order);
  });
});
