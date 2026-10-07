import { describe, expect, it } from "vitest";
import { applyDownloadSecurityHeaders } from "./download-headers.server";

describe("applyDownloadSecurityHeaders", () => {
  it("always sets nosniff", () => {
    const h = applyDownloadSecurityHeaders(new Headers(), "image/png");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves inline-safe media types inline", () => {
    for (const ct of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/webm",
      "audio/mpeg",
      "application/pdf",
    ]) {
      const h = applyDownloadSecurityHeaders(new Headers(), ct);
      expect(h.get("Content-Disposition"), ct).toBe("inline");
    }
  });

  it("forces attachment for active-document types (XSS sink)", () => {
    for (const ct of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "application/xml",
      "text/plain",
      "application/octet-stream",
    ]) {
      const h = applyDownloadSecurityHeaders(new Headers(), ct);
      expect(h.get("Content-Disposition"), ct).toBe("attachment");
    }
  });

  it("ignores charset/params and casing when matching the allowlist", () => {
    expect(
      applyDownloadSecurityHeaders(
        new Headers(),
        "IMAGE/PNG; charset=binary",
      ).get("Content-Disposition"),
    ).toBe("inline");
    expect(
      applyDownloadSecurityHeaders(
        new Headers(),
        "text/HTML; charset=utf-8",
      ).get("Content-Disposition"),
    ).toBe("attachment");
  });

  it("treats an unparseable/empty content type as attachment", () => {
    expect(
      applyDownloadSecurityHeaders(new Headers(), "").get(
        "Content-Disposition",
      ),
    ).toBe("attachment");
  });
});
