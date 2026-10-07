// Unit tests for DCR abuse-control validation.
import { describe, expect, it } from "vitest";
import { validateClientName, validateDcrRedirectUri } from "./dcr-validation";

describe("validateClientName", () => {
  it("accepts a plain name", () => {
    expect(validateClientName("My Cool App")).toBeNull();
  });

  it("accepts unicode names", () => {
    expect(validateClientName("Caf\u00e9 \u00dcnicode")).toBeNull();
    expect(validateClientName("café")).toBeNull();
  });

  it("rejects non-string", () => {
    expect(validateClientName(undefined)).not.toBeNull();
    expect(validateClientName(42)).not.toBeNull();
    expect(validateClientName({})).not.toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateClientName("")).not.toBeNull();
    expect(validateClientName("   ")).not.toBeNull();
  });

  it("rejects oversized", () => {
    expect(validateClientName("x".repeat(81))).not.toBeNull();
    expect(validateClientName("x".repeat(80))).toBeNull();
  });

  it("rejects control characters (C0)", () => {
    expect(validateClientName(`a${String.fromCharCode(0)}b`)).not.toBeNull();
    expect(validateClientName(`a${String.fromCharCode(7)}b`)).not.toBeNull();
    expect(validateClientName(`a${String.fromCharCode(0x1f)}b`)).not.toBeNull();
  });

  it("rejects control characters (C1 / DEL)", () => {
    expect(validateClientName(`a${String.fromCharCode(0x7f)}b`)).not.toBeNull();
    expect(validateClientName(`a${String.fromCharCode(0x9f)}b`)).not.toBeNull();
  });

  it("accepts s2-related names (`s2` is intentionally NOT reserved — see RESERVED_NAME_TOKENS comment)", () => {
    expect(validateClientName("S2 Client")).toBeNull();
    expect(validateClientName("S2 Drive")).toBeNull();
  });

  it("rejects reserved word: official / verified / admin / system", () => {
    expect(validateClientName("Official App")).not.toBeNull();
    expect(validateClientName("verified by us")).not.toBeNull();
    expect(validateClientName("admin tools")).not.toBeNull();
    expect(validateClientName("system control")).not.toBeNull();
  });

  it("does not reject substring matches inside other words", () => {
    expect(validateClientName("administer")).toBeNull(); // 'admin' is a substring but not whole-word
    expect(validateClientName("Verifier")).toBeNull(); // 'verified' not present (different stem)
    expect(validateClientName("Subassembly")).toBeNull(); // no token at all
    expect(validateClientName("DiscordBot")).toBeNull();
  });
});

describe("validateDcrRedirectUri", () => {
  it("accepts https://", () => {
    expect(validateDcrRedirectUri("https://example.com/cb")).toBeNull();
    expect(
      validateDcrRedirectUri("https://app.example.com/oauth/cb"),
    ).toBeNull();
  });

  it("accepts http://127.0.0.1 (any port and path)", () => {
    expect(validateDcrRedirectUri("http://127.0.0.1/cb")).toBeNull();
    expect(validateDcrRedirectUri("http://127.0.0.1:51234/cb")).toBeNull();
    expect(validateDcrRedirectUri("http://127.0.0.1:8080/")).toBeNull();
  });

  it("accepts http://localhost (any port and path)", () => {
    expect(validateDcrRedirectUri("http://localhost/cb")).toBeNull();
    expect(validateDcrRedirectUri("http://localhost:3000/oauth/cb")).toBeNull();
  });

  it("rejects http:// to non-loopback hosts", () => {
    expect(validateDcrRedirectUri("http://example.com/cb")).not.toBeNull();
    expect(validateDcrRedirectUri("http://192.168.1.1/cb")).not.toBeNull();
    expect(validateDcrRedirectUri("http://attacker.example/cb")).not.toBeNull();
  });

  it("rejects custom schemes", () => {
    expect(validateDcrRedirectUri("myapp://callback")).not.toBeNull();
    expect(validateDcrRedirectUri("com.example.app:/oauth")).not.toBeNull();
  });

  it("rejects javascript: and data:", () => {
    expect(validateDcrRedirectUri("javascript:alert(1)")).not.toBeNull();
    expect(validateDcrRedirectUri("data:text/html,<script>")).not.toBeNull();
  });

  it("rejects fragment in URI (RFC 7591)", () => {
    expect(validateDcrRedirectUri("https://x/cb#frag")).not.toBeNull();
  });

  it("rejects malformed URI", () => {
    expect(validateDcrRedirectUri("not-a-url")).not.toBeNull();
    expect(validateDcrRedirectUri("")).not.toBeNull();
  });

  it("rejects non-string input", () => {
    expect(validateDcrRedirectUri(undefined)).not.toBeNull();
    expect(validateDcrRedirectUri(42)).not.toBeNull();
  });
});
