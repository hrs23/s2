import { describe, expect, it } from "vitest";
import { createSelfHostRequestHeaders } from "./request-headers.server";

describe("createSelfHostRequestHeaders", () => {
  it("sets x-s2-client-ip from the socket address", () => {
    const headers = createSelfHostRequestHeaders(
      { host: "s2.local", "user-agent": "test-client" },
      "203.0.113.10",
    );

    expect(headers.get("host")).toBe("s2.local");
    expect(headers.get("user-agent")).toBe("test-client");
    expect(headers.get("x-s2-client-ip")).toBe("203.0.113.10");
  });

  it("does not trust an incoming x-s2-client-ip header", () => {
    const headers = createSelfHostRequestHeaders(
      {
        host: "s2.local",
        "x-s2-client-ip": "198.51.100.99",
      },
      "203.0.113.10",
    );

    expect(headers.get("x-s2-client-ip")).toBe("203.0.113.10");
  });

  it("removes incoming x-s2-client-ip when the socket address is unavailable", () => {
    const headers = createSelfHostRequestHeaders(
      { "x-s2-client-ip": "198.51.100.99" },
      undefined,
    );

    expect(headers.has("x-s2-client-ip")).toBe(false);
  });
});
