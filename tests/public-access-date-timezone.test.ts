import { describe, expect, test } from "vitest";
import { toDateOnly } from "../src/lib/licenses";

describe("public access billing date mapping", () => {
  test("maps the end of a Brazilian billing day without leaking its UTC next-day date", () => {
    expect(toDateOnly("2026-09-22T02:59:59.999Z")).toBe("2026-09-21");
  });

  test("preserves already normalized dates", () => {
    expect(toDateOnly("2026-09-21")).toBe("2026-09-21");
  });
});
