// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn, serializeError } from "./logger.server";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serializeError", () => {
  it("extracts name / message / stack from Error", () => {
    const err = new Error("boom");
    const out = serializeError(err);
    expect(out).toMatchObject({ name: "Error", message: "boom" });
    expect(out.stack).toContain("Error: boom");
  });

  it("preserves Error subclass name", () => {
    class TokenError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "TokenError";
      }
    }
    const out = serializeError(new TokenError("bad"));
    expect(out.name).toBe("TokenError");
    expect(out.message).toBe("bad");
  });

  it("recursively serializes Error.cause", () => {
    const inner = new Error("root");
    const outer = new Error("wrapper", { cause: inner });
    const out = serializeError(outer);
    expect(out.cause).toMatchObject({ name: "Error", message: "root" });
  });

  it("returns { value } for plain objects", () => {
    const out = serializeError({ foo: "bar" });
    expect(out).toEqual({ value: { foo: "bar" } });
  });

  it("returns { value } for primitives", () => {
    expect(serializeError("oops")).toEqual({ value: "oops" });
    expect(serializeError(42)).toEqual({ value: "42" });
    expect(serializeError(null)).toEqual({ value: "null" });
    expect(serializeError(undefined)).toEqual({ value: "undefined" });
  });

  it("falls back to String() for non-serializable objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = serializeError(circular);
    expect(typeof out.value).toBe("string");
  });

  it("does not produce [object Object] for Error input", () => {
    // Regression test for the production bug: console.error(new Error(...))
    // produced "[object Object]" in Loki.
    const out = serializeError(new Error("x"));
    expect(JSON.stringify(out)).not.toContain("[object Object]");
  });
});

describe("logInfo", () => {
  it("emits a single JSON object with component and event", () => {
    logInfo("cron", "completed", { deleted: 5 });
    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const [payload] = consoleLogSpy.mock.calls[0];
    expect(payload).toEqual({
      component: "cron",
      event: "completed",
      deleted: 5,
    });
  });

  it("works without attrs", () => {
    logInfo("cron", "completed");
    expect(consoleLogSpy.mock.calls[0][0]).toEqual({
      component: "cron",
      event: "completed",
    });
  });
});

describe("logWarn", () => {
  it("emits a single JSON object with component, event, and attrs", () => {
    // Use a neutral id in the example — `cus_...` / email etc. are PII per
    // docs/pii.md and should never appear in logs (even in test fixtures).
    logWarn("cron", "over_quota_user", { userId: "01HX..." });
    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    expect(consoleWarnSpy.mock.calls[0][0]).toEqual({
      component: "cron",
      event: "over_quota_user",
      userId: "01HX...",
    });
  });

  it("serializes an optional error into err field", () => {
    logWarn("db.transaction", "rollback_failed", {}, new Error("EPIPE"));
    const [payload] = consoleWarnSpy.mock.calls[0];
    expect(payload).toMatchObject({
      component: "db.transaction",
      event: "rollback_failed",
      err: { name: "Error", message: "EPIPE" },
    });
  });
});

describe("logError", () => {
  it("emits a single JSON object with component, event, attrs, and err", () => {
    logError("auth", "verify_failed", { userId: "u1" }, new Error("bad token"));
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const [payload] = consoleErrorSpy.mock.calls[0];
    expect(payload).toMatchObject({
      component: "auth",
      event: "verify_failed",
      userId: "u1",
      err: { name: "Error", message: "bad token" },
    });
  });

  it("works without an error argument", () => {
    logError("api", "validation_failed", { field: "email" });
    const [payload] = consoleErrorSpy.mock.calls[0];
    expect(payload).toEqual({
      component: "api",
      event: "validation_failed",
      field: "email",
    });
    expect(payload).not.toHaveProperty("err");
  });

  it("serializes non-Error throwables", () => {
    logError("api", "call_failed", {}, "string error");
    const [payload] = consoleErrorSpy.mock.calls[0];
    expect(payload.err).toEqual({ value: "string error" });
  });

  it("does not accidentally stringify the payload object", () => {
    // Regression test: console.error(prefix, errObj) produced "[object Object]"
    // because JS stringifies the second arg. Now we pass one structured object.
    logError("ssr", "render_failed", { pathname: "/x" }, new Error("bad"));
    const [payload] = consoleErrorSpy.mock.calls[0];
    expect(typeof payload).toBe("object");
    expect(payload).not.toBe(undefined);
    expect(JSON.stringify(payload)).not.toContain("[object Object]");
  });
});
