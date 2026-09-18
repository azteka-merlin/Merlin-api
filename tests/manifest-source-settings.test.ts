import { describe, expect, test } from "vitest";
import { manifestPrimarySourceOrder } from "../src/lib/manifest-source-settings";

describe("manifest source priority", () => {
  test("keeps DepotBox first by default", () => {
    expect(manifestPrimarySourceOrder(undefined)).toEqual(["depotbox", "ryuu", "contrary"]);
    expect(manifestPrimarySourceOrder("depotbox")).toEqual(["depotbox", "ryuu", "contrary"]);
  });

  test("moves Ryuu ahead of DepotBox when configured", () => {
    expect(manifestPrimarySourceOrder("ryuu")).toEqual(["ryuu", "depotbox", "contrary"]);
  });

  test("moves Contrary ahead of the other sources when configured", () => {
    expect(manifestPrimarySourceOrder("contrary")).toEqual(["contrary", "depotbox", "ryuu"]);
  });
});
