import { describe, expect, it } from "vitest";
import { parseTree } from "~/lib/files/tree";

describe("parseTree", () => {
  it("skips items with an empty name", () => {
    const entries = parseTree(
      [
        {
          id: "n1",
          name: "",
          type: "file",
          size: 1,
          modified_at: "2026-01-01T00:00:00.000Z",
          content_version: 1,
          content_type: "text/plain",
        },
        {
          id: "n2",
          name: "readme.txt",
          type: "file",
          size: 2,
          modified_at: "2026-01-01T00:00:00.000Z",
          content_version: 1,
          content_type: "text/plain",
        },
      ],
      "docs/",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "readme.txt",
      type: "file",
      fullKey: "docs/readme.txt",
    });
  });
});
