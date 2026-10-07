import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cronMatchesUtc,
  startMaintenanceScheduler,
} from "./maintenance-scheduler.server";

describe("cronMatchesUtc", () => {
  it("matches the default daily maintenance cron at 17:00 UTC", () => {
    const at = new Date(Date.UTC(2026, 8, 7, 17, 0, 12));
    expect(cronMatchesUtc("0 17 * * *", at)).toBe(true);
  });

  it("rejects other minutes", () => {
    const at = new Date(Date.UTC(2026, 8, 7, 17, 1, 0));
    expect(cronMatchesUtc("0 17 * * *", at)).toBe(false);
  });

  it("supports lists and ranges", () => {
    const at = new Date(Date.UTC(2026, 8, 7, 9, 15, 0));
    expect(cronMatchesUtc("15 9-10 * * 0,1", at)).toBe(true);
  });

  it("supports step from star", () => {
    const at = new Date(Date.UTC(2026, 8, 7, 17, 0, 0));
    expect(cronMatchesUtc("*/15 17 * * *", at)).toBe(true);
    expect(
      cronMatchesUtc(
        "*/15 17 * * *",
        new Date(Date.UTC(2026, 8, 7, 17, 15, 0)),
      ),
    ).toBe(true);
    expect(
      cronMatchesUtc("*/15 17 * * *", new Date(Date.UTC(2026, 8, 7, 17, 7, 0))),
    ).toBe(false);
  });

  it("supports step from range and bare start", () => {
    expect(
      cronMatchesUtc(
        "0-30/10 17 * * *",
        new Date(Date.UTC(2026, 8, 7, 17, 20, 0)),
      ),
    ).toBe(true);
    expect(
      cronMatchesUtc(
        "0-30/10 17 * * *",
        new Date(Date.UTC(2026, 8, 7, 17, 25, 0)),
      ),
    ).toBe(false);
    expect(
      cronMatchesUtc(
        "5/10 17 * * *",
        new Date(Date.UTC(2026, 8, 7, 17, 15, 0)),
      ),
    ).toBe(true);
    expect(
      cronMatchesUtc(
        "5/10 17 * * *",
        new Date(Date.UTC(2026, 8, 7, 17, 16, 0)),
      ),
    ).toBe(false);
  });

  it("ignores invalid step segments", () => {
    expect(
      cronMatchesUtc("*/0 17 * * *", new Date(Date.UTC(2026, 8, 7, 17, 0, 0))),
    ).toBe(false);
    expect(
      cronMatchesUtc("*/x 17 * * *", new Date(Date.UTC(2026, 8, 7, 17, 0, 0))),
    ).toBe(false);
  });

  it("matches month and day-of-month fields", () => {
    const at = new Date(Date.UTC(2026, 8, 7, 17, 0, 0)); // Sep 7
    expect(cronMatchesUtc("0 17 7 9 *", at)).toBe(true);
    expect(cronMatchesUtc("0 17 8 9 *", at)).toBe(false);
    expect(cronMatchesUtc("0 17 7 10 *", at)).toBe(false);
  });

  it("rejects ranges that do not contain the value", () => {
    expect(
      cronMatchesUtc("0 10-12 * * *", new Date(Date.UTC(2026, 8, 7, 9, 0, 0))),
    ).toBe(false);
  });

  it("throws on non-five-field expressions", () => {
    expect(() => cronMatchesUtc("0 17 * *", new Date())).toThrow(/5-field/);
    expect(() => cronMatchesUtc("0 17 * * * *", new Date())).toThrow(/5-field/);
  });
});

describe("startMaintenanceScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when disabled", () => {
    const run = vi.fn(async () => {});
    const handle = startMaintenanceScheduler({} as Env, {
      enabled: false,
      run,
      intervalMs: 10,
    });
    handle.stop();
    expect(run).not.toHaveBeenCalled();
  });

  it("throws when cron is invalid at start", () => {
    expect(() =>
      startMaintenanceScheduler({} as Env, {
        cron: "bad",
        run: async () => {},
      }),
    ).toThrow(/5-field/);
  });

  it("fires once per matching minute and skips overlap", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    let now = new Date(Date.UTC(2026, 8, 7, 17, 0, 5));
    const handle = startMaintenanceScheduler({} as Env, {
      cron: "0 17 * * *",
      intervalMs: 10,
      now: () => now,
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    now = new Date(Date.UTC(2026, 8, 7, 17, 0, 20));
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    now = new Date(Date.UTC(2026, 8, 7, 17, 1, 0));
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);

    now = new Date(Date.UTC(2026, 8, 8, 17, 0, 0));
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("swallows runner failures and continues", async () => {
    vi.useFakeTimers();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    let now = new Date(Date.UTC(2026, 8, 7, 17, 0, 0));
    const handle = startMaintenanceScheduler({} as Env, {
      cron: "0 17 * * *",
      intervalMs: 10,
      now: () => now,
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    now = new Date(Date.UTC(2026, 8, 8, 17, 0, 0));
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("stop prevents further ticks", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    let now = new Date(Date.UTC(2026, 8, 7, 16, 0, 0));
    const handle = startMaintenanceScheduler({} as Env, {
      cron: "0 17 * * *",
      intervalMs: 10,
      now: () => now,
      run,
    });
    expect(run).not.toHaveBeenCalled();
    handle.stop();
    now = new Date(Date.UTC(2026, 8, 7, 17, 0, 0));
    await vi.advanceTimersByTimeAsync(50);
    expect(run).not.toHaveBeenCalled();
  });
});
