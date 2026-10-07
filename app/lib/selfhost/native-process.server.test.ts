import { describe, expect, it, vi } from "vitest";
import { captureNativeProcess } from "./native-process.server";

describe("captureNativeProcess", () => {
  it("keeps build paths and streams from before the server build import", () => {
    let cwd = "/app";
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const nativeProcess = captureNativeProcess({
      cwd: () => cwd,
      stdout,
      stderr,
    });

    cwd = "/";

    expect(nativeProcess.clientDir).toBe("/app/build/client");
    expect(nativeProcess.serverBuildDir).toBe("/app/build/server");
    expect(nativeProcess.stdout).toBe(stdout);
    expect(nativeProcess.stderr).toBe(stderr);
  });
});
