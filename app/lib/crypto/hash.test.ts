import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.server";

describe("sha256Hex", () => {
  it("returns known SHA-256 hex for empty input", async () => {
    const hash = await sha256Hex(new ArrayBuffer(0));
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
