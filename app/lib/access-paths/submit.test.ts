import { describe, expect, it } from "vitest";
import { accessPathsForSubmit } from "./submit";

describe("accessPathsForSubmit", () => {
  it("returns the canonical 'all under base_path' row for an empty list", () => {
    expect(accessPathsForSubmit([])).toEqual([{ path: "", access: "write" }]);
  });

  it("returns the input unchanged when at least one row exists", () => {
    const paths = [
      { path: "docs", access: "read" as const },
      { path: "photos", access: "write" as const },
    ];
    expect(accessPathsForSubmit(paths)).toBe(paths);
  });
});
