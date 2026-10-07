import { describe, expect, it } from "vitest";
import { trimAccessPathRows, validateAccessPaths } from "./validate";

describe("trimAccessPathRows", () => {
  it("trims whitespace from paths", () => {
    expect(trimAccessPathRows([{ path: "  /docs  ", access: "read" }])).toEqual(
      [{ path: "/docs", access: "read" }],
    );
  });

  it("drops whitespace-only rows", () => {
    expect(trimAccessPathRows([{ path: "   ", access: "write" }])).toEqual([]);
  });

  it("preserves path='' (canonical root form)", () => {
    expect(trimAccessPathRows([{ path: "", access: "write" }])).toEqual([
      { path: "", access: "write" },
    ]);
  });

  it("preserves path='' alongside non-empty paths", () => {
    expect(
      trimAccessPathRows([
        { path: "", access: "write" },
        { path: "docs", access: "read" },
      ]),
    ).toEqual([
      { path: "", access: "write" },
      { path: "docs", access: "read" },
    ]);
  });
});

describe("validateAccessPaths", () => {
  it("returns null when all rows have non-empty unique paths", () => {
    expect(
      validateAccessPaths([
        { path: "a", access: "read" },
        { path: "b", access: "write" },
      ]),
    ).toBeNull();
  });

  it("accepts path='' as canonical root form", () => {
    expect(validateAccessPaths([{ path: "", access: "write" }])).toBeNull();
  });

  it("accepts path='' alongside non-empty paths", () => {
    expect(
      validateAccessPaths([
        { path: "docs", access: "read" },
        { path: "", access: "write" },
      ]),
    ).toBeNull();
  });

  it("flags duplicate paths", () => {
    expect(
      validateAccessPaths([
        { path: "a", access: "read" },
        { path: "a", access: "write" },
      ]),
    ).toEqual({ kind: "duplicate_paths" });
  });

  it("flags duplicate path=''", () => {
    expect(
      validateAccessPaths([
        { path: "", access: "read" },
        { path: "", access: "write" },
      ]),
    ).toEqual({ kind: "duplicate_paths" });
  });

  it("returns null for empty list when minRows defaults to 0", () => {
    expect(validateAccessPaths([])).toBeNull();
  });

  it("flags below minRows", () => {
    expect(validateAccessPaths([], { minRows: 1 })).toEqual({
      kind: "min_rows",
    });
  });
});
