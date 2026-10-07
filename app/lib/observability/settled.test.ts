// @vitest-environment node
import { describe, expect, it } from "vitest";
import { summarizeAllSettled } from "./settled";

describe("summarizeAllSettled", () => {
  it("records ok with value for fulfilled entries", () => {
    const out = summarizeAllSettled(["a", "b"] as const, [
      { status: "fulfilled", value: { deleted: 5 } },
      { status: "fulfilled", value: { deleted: 0 } },
    ]);
    expect(out).toEqual({
      a: { status: "ok", value: { deleted: 5 } },
      b: { status: "ok", value: { deleted: 0 } },
    });
  });

  it("collapses rejected to { status: 'failed' } without exposing reason", () => {
    const out = summarizeAllSettled(["a"] as const, [
      { status: "rejected", reason: new Error("boom") },
    ]);
    expect(out).toEqual({ a: { status: "failed" } });
    // Crucially: the Error object is not leaked into the structure.
    expect(JSON.stringify(out)).not.toContain("boom");
  });

  it("handles mixed fulfilled + rejected entries", () => {
    const out = summarizeAllSettled(
      ["trash_purge", "version_pruning", "orphan_cleanup"] as const,
      [
        { status: "fulfilled", value: { purged: 3 } },
        { status: "rejected", reason: new Error("db unavailable") },
        { status: "fulfilled", value: null },
      ],
    );
    expect(out).toEqual({
      trash_purge: { status: "ok", value: { purged: 3 } },
      version_pruning: { status: "failed" },
      orphan_cleanup: { status: "ok", value: null },
    });
  });
});
