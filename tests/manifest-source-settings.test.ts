import { describe, expect, test } from "vitest";
import { manifestPrimarySourceOrder } from "../src/lib/manifest-source-settings";

describe("manifest source priority", () => {
  test("keeps DepotBox first by default", () => {
    expect(manifestPrimarySourceOrder(undefined)).toEqual(["depotbox", "ryuu", "steam-api"]);
    expect(manifestPrimarySourceOrder("depotbox")).toEqual(["depotbox", "ryuu", "steam-api"]);
  });

  test("moves Ryuu ahead of DepotBox when configured", () => {
    expect(manifestPrimarySourceOrder("ryuu")).toEqual(["ryuu", "depotbox", "steam-api"]);
  });

  test("moves Steam API ahead of the other sources when configured", () => {
    expect(manifestPrimarySourceOrder("steam-api")).toEqual(["steam-api", "depotbox", "ryuu"]);
  });
});
