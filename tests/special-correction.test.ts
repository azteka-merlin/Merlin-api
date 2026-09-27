import { describe, expect, test } from "vitest";
import {
  SPECIAL_CORRECTION_ACTIVATION_TYPE,
  SPECIAL_CORRECTION_APP_ID,
  SPECIAL_CORRECTION_MINIMUM_VERSION,
  specialCorrectionMetadata,
  supportsSpecialCorrection,
} from "../src/lib/special-correction";

describe("special correction compatibility", () => {
  test("blocks missing, invalid and versions through 1.6.7", () => {
    expect(supportsSpecialCorrection(null)).toBe(false);
    expect(supportsSpecialCorrection("invalid")).toBe(false);
    expect(supportsSpecialCorrection("1.6.7")).toBe(false);
    expect(supportsSpecialCorrection("v1.6.7")).toBe(false);
  });

  test("accepts version 1.6.8 and newer", () => {
    expect(supportsSpecialCorrection("1.6.8")).toBe(true);
    expect(supportsSpecialCorrection("1.6.8-dev")).toBe(true);
    expect(supportsSpecialCorrection("1.7.0")).toBe(true);
    expect(supportsSpecialCorrection("2.0.0")).toBe(true);
  });

  test("adds metadata only to the configured AppID", () => {
    expect(specialCorrectionMetadata(SPECIAL_CORRECTION_APP_ID)).toEqual({
      activationType: SPECIAL_CORRECTION_ACTIVATION_TYPE,
      minimumLauncherVersion: SPECIAL_CORRECTION_MINIMUM_VERSION,
    });
    expect(specialCorrectionMetadata("123")).toEqual({});
  });
});
