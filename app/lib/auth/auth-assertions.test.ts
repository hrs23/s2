import { describe, expect, it } from "vitest";
import { assertServiceUserMatches } from "~/lib/auth/auth-assertions.server";

describe("assertServiceUserMatches", () => {
  it("throws when auth user_id does not match the service container", () => {
    expect(() =>
      assertServiceUserMatches({ type: "user", user_id: "user_a" }, "user_b"),
    ).toThrow(/service user mismatch/);
  });
});
