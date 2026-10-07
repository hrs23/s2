import { describe, expect, it } from "vitest";
import {
  daysUntilPurge,
  exceedsPreviewLimit,
  getPreviewType,
  isTextFile,
  PREVIEW_SIZE_LIMITS,
} from "./file-utils";

describe("getPreviewType", () => {
  it("detects images", () => {
    expect(getPreviewType("photo.jpg")).toBe("image");
    expect(getPreviewType("photo.JPEG")).toBe("image");
    expect(getPreviewType("art.png")).toBe("image");
    expect(getPreviewType("anim.gif")).toBe("image");
    expect(getPreviewType("logo.webp")).toBe("image");
  });

  it("detects video and audio", () => {
    expect(getPreviewType("clip.mp4")).toBe("video");
    expect(getPreviewType("clip.webm")).toBe("video");
    expect(getPreviewType("song.mp3")).toBe("audio");
    expect(getPreviewType("song.wav")).toBe("audio");
    expect(getPreviewType("song.ogg")).toBe("audio");
    expect(getPreviewType("song.m4a")).toBe("audio");
  });

  it("detects PDF", () => {
    expect(getPreviewType("paper.pdf")).toBe("pdf");
    expect(getPreviewType("paper.PDF")).toBe("pdf");
  });

  it("detects markdown vs code", () => {
    expect(getPreviewType("README.md")).toBe("markdown");
    expect(getPreviewType("notes.markdown")).toBe("markdown");
    expect(getPreviewType("hello.py")).toBe("code");
    expect(getPreviewType("hello.ts")).toBe("code");
    expect(getPreviewType("data.json")).toBe("code");
  });

  it("returns code for HTML and SVG (source view only — never rendered)", () => {
    // HTML and SVG must not be rendered. Falling into the "code"
    // bucket means they go through Shiki / textarea, never <iframe>/<img>.
    expect(getPreviewType("page.html")).toBe("code");
    expect(getPreviewType("page.htm")).toBe("code");
    expect(getPreviewType("icon.svg")).toBe("code");
  });

  it("returns none for unknown / unsupported types", () => {
    expect(getPreviewType("doc.docx")).toBe("none");
    expect(getPreviewType("photo.heic")).toBe("none");
    expect(getPreviewType("photo.tiff")).toBe("none");
    expect(getPreviewType("archive.zip")).toBe("none");
    expect(getPreviewType("model.stl")).toBe("none");
    expect(getPreviewType("noext")).toBe("none");
  });
});

describe("isTextFile", () => {
  it("is true for code and markdown", () => {
    expect(isTextFile("README.md")).toBe(true);
    expect(isTextFile("config.json")).toBe(true);
    expect(isTextFile("script.py")).toBe(true);
  });
  it("is false for binary previewable types", () => {
    expect(isTextFile("photo.jpg")).toBe(false);
    expect(isTextFile("clip.mp4")).toBe(false);
    expect(isTextFile("paper.pdf")).toBe(false);
  });
});

describe("exceedsPreviewLimit", () => {
  it("returns null when under the limit", () => {
    expect(exceedsPreviewLimit("a.md", 1024)).toBeNull();
    expect(exceedsPreviewLimit("a.png", 1024)).toBeNull();
  });
  it("returns null when size is unknown", () => {
    expect(exceedsPreviewLimit("a.md", null)).toBeNull();
    expect(exceedsPreviewLimit("a.md", undefined)).toBeNull();
  });
  it("returns the limit when text content is too large (8MB)", () => {
    expect(exceedsPreviewLimit("a.md", 9 * 1024 * 1024)).toBe(
      PREVIEW_SIZE_LIMITS.markdown,
    );
    expect(exceedsPreviewLimit("a.py", 9 * 1024 * 1024)).toBe(
      PREVIEW_SIZE_LIMITS.code,
    );
  });
  it("returns the limit when image is too large (100MB)", () => {
    expect(exceedsPreviewLimit("a.png", 101 * 1024 * 1024)).toBe(
      PREVIEW_SIZE_LIMITS.image,
    );
  });
  it("does not cap PDF / video / audio (browser streams)", () => {
    expect(exceedsPreviewLimit("a.pdf", 500 * 1024 * 1024)).toBeNull();
    expect(exceedsPreviewLimit("a.mp4", 500 * 1024 * 1024)).toBeNull();
    expect(exceedsPreviewLimit("a.mp3", 500 * 1024 * 1024)).toBeNull();
  });
});

describe("daysUntilPurge", () => {
  const day = 24 * 60 * 60 * 1000;

  it("returns 30 for an item deleted now", () => {
    expect(daysUntilPurge(new Date().toISOString())).toBe(30);
  });

  it("returns 15 for an item deleted 15 days ago", () => {
    expect(daysUntilPurge(new Date(Date.now() - 15 * day).toISOString())).toBe(
      15,
    );
  });

  it("clamps to 0 after the retention period", () => {
    expect(daysUntilPurge(new Date(Date.now() - 31 * day).toISOString())).toBe(
      0,
    );
  });

  it("returns null for null input", () => {
    expect(daysUntilPurge(null)).toBeNull();
  });
});
