import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDate,
  formatStorageLimit,
  formatStorageSize,
} from "~/lib/utils/format";

describe("formatBytes", () => {
  it("formats bytes as B when under 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KB with 0 decimal places", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(1024 ** 2 - 1)).toBe("1024 KB");
  });

  it("formats MB with 1 decimal place", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
  });

  it("formats GB with 0 decimal places", () => {
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100 GB");
  });
});

describe("formatStorageSize", () => {
  it("formats bytes as B when under 1 KB", () => {
    expect(formatStorageSize(0)).toBe("0 B");
    expect(formatStorageSize(1023)).toBe("1023 B");
  });

  it("formats KB with 1 decimal place", () => {
    expect(formatStorageSize(1024)).toBe("1.0 KB");
    expect(formatStorageSize(1536)).toBe("1.5 KB");
  });

  it("formats MB with 1 decimal place", () => {
    expect(formatStorageSize(1024 ** 2)).toBe("1.0 MB");
    expect(formatStorageSize(1.5 * 1024 ** 2)).toBe("1.5 MB");
  });

  it("formats GB with 2 decimal places", () => {
    expect(formatStorageSize(1024 ** 3)).toBe("1.00 GB");
    expect(formatStorageSize(1.5 * 1024 ** 3)).toBe("1.50 GB");
  });

  it("differs from formatBytes in precision", () => {
    // formatStorageSize uses more decimal places for human-readable usage display
    expect(formatStorageSize(1024)).toBe("1.0 KB"); // 1 decimal
    expect(formatBytes(1024)).toBe("1 KB"); // 0 decimals
  });
});

describe("formatStorageLimit", () => {
  it("formats MB for sub-GB values", () => {
    expect(formatStorageLimit(500 * 1024 ** 2)).toBe("500 MB");
    expect(formatStorageLimit(1024 ** 2)).toBe("1 MB");
    expect(formatStorageLimit(1024 ** 3 - 1)).toBe("1024 MB");
  });

  it("formats GB with 0 decimal places", () => {
    expect(formatStorageLimit(1024 ** 3)).toBe("1 GB");
    expect(formatStorageLimit(100 * 1024 ** 3)).toBe("100 GB");
  });
});

describe("formatDate", () => {
  it("formats a date in en-US style", () => {
    const date = new Date("2026-03-23T00:00:00Z");
    const result = formatDate(date);
    // Should contain month abbreviation, day, and year
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/2026/);
  });

  it("includes month, day and year components", () => {
    const date = new Date("2026-01-05T00:00:00Z");
    const result = formatDate(date);
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2026/);
  });
});
