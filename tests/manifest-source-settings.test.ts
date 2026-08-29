import { describe, expect, test } from "vitest";
import { manifestPrimarySourceOrder } from "../src/lib/manifest-source-settings";

describe("manifest source priority", () => {
  test("keeps DepotBox first by default", () => {
    expect(manifestPrimarySourceOrder(undefined)).toEqual(["depotbox", "ryuu"]);
    expect(manifestPrimarySourceOrder("depotbox")).toEqual(["depotbox", "ryuu"]);
  });

  test("moves Ryuu ahead of DepotBox when configured", () => {
    expect(manifestPrimarySourceOrder("ryuu")).toEqual(["ryuu", "depotbox"]);
  });
});
