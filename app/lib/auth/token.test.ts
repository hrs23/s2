import { describe, expect, it } from "vitest";
import {
  generateS2Token,
  hashToken,
  randomString,
} from "~/lib/auth/token.server";

describe("randomString", () => {
  it("returns a string of the specified length", () => {
    const s = randomString("abc", 10);
    expect(s).toHaveLength(10);
  });

  it("contains only characters from the given alphabet", () => {
    const alphabet = "ABCDEF0123456789";
    const s = randomString(alphabet, 50);
    for (const c of s) {
      expect(alphabet.includes(c)).toBe(true);
    }
  });

  it("produces different results on two calls (almost certainly)", () => {
    const a = randomString(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      32,
    );
    const b = randomString(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      32,
    );
    expect(a).not.toBe(b);
  });
});

describe("generateS2Token", () => {
  it("returns a 35-character token starting with s2_", () => {
    const token = generateS2Token();
    expect(token).toMatch(/^s2_[0-9A-Za-z]{32}$/);
  });

  it("produces different tokens on two calls", () => {
    expect(generateS2Token()).not.toBe(generateS2Token());
  });
});

describe("hashToken", () => {
  it("matches a known SHA-256 hash", async () => {
    // echo -n "hello" | sha256sum = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const hash = await hashToken("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
