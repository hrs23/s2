import { describe, expect, it } from "vitest";
import { err, readJson } from "~/lib/utils/http.server";

describe("err", () => {
  it.each([
    [400, "validation_error"],
    [404, "not_found"],
    [410, "gone"],
    [412, "precondition_failed"],
    [413, "storage_limit_exceeded"],
    [500, "error"],
  ])("maps status %i to code %s", async (status, code) => {
    const res = err(status, "msg");
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code, message: "msg" } });
  });

  it("supports custom error code", async () => {
    const res = err(410, "Cursor expired", "cursor_invalid");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: { code: "cursor_invalid", message: "Cursor expired" },
    });
  });
});

describe("readJson", () => {
  const post = (body: string) =>
    new Request("http://x/", { method: "POST", body });

  it.each(["null", "[1]", "3", '"s"', "{bad"])("rejects body %s", async (b) => {
    const r = await readJson(post(b));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("accepts an object", async () => {
    const r = await readJson<{ a: number }>(post('{"a":1}'));
    expect(r).toEqual({ ok: true, body: { a: 1 } });
  });
});
