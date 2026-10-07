import { describe, expect, it } from "vitest";
import { generateUlidForApi } from "~/lib/utils/ulid.server";

describe("generateUlidForApi", () => {
  it("returns a 20-character string", () => {
    const id = generateUlidForApi();
    expect(id).toHaveLength(20);
  });

  it("uses only Crockford base32 characters", () => {
    const id = generateUlidForApi();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it("generates unique values", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateUlidForApi()),
    );
    expect(ids.size).toBe(100);
  });
});
