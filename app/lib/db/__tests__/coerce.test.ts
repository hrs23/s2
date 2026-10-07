import { describe, expect, it } from "vitest";
import { coercePgInstant } from "../coerce.server";

describe("coercePgInstant", () => {
  it("converts Date to ISO 8601 (canonical UTC)", () => {
    const d = new Date(Date.UTC(2026, 3, 26, 12, 30, 45, 123));
    expect(coercePgInstant(d)).toBe("2026-04-26T12:30:45.123Z");
  });

  it("returns string values unchanged", () => {
    expect(coercePgInstant("2026-04-26T12:30:45.123Z")).toBe(
      "2026-04-26T12:30:45.123Z",
    );
  });

  it("returns null for null/undefined", () => {
    expect(coercePgInstant(null)).toBeNull();
    expect(coercePgInstant(undefined)).toBeNull();
  });

  it("falls back to String() for unexpected types", () => {
    expect(coercePgInstant(42)).toBe("42");
  });
});
