import { describe, expect, it } from "vitest";
import {
  createMarkdownRenderer,
  resolveMarkdownImageSrc,
} from "./file-preview";

describe("resolveMarkdownImageSrc", () => {
  it("rewrites a relative sibling path to an /api/files URL", () => {
    expect(
      resolveMarkdownImageSrc("attachments/abc.jpg", "koto.md/2026-04-25.md"),
    ).toBe("/api/v1/files/koto.md/attachments/abc.jpg");
  });

  it("handles ./ prefix in relative path", () => {
    expect(resolveMarkdownImageSrc("./img.png", "docs/note.md")).toBe(
      "/api/v1/files/docs/img.png",
    );
  });

  it("handles ../ to go up one directory", () => {
    expect(resolveMarkdownImageSrc("../shared/x.png", "docs/sub/note.md")).toBe(
      "/api/v1/files/docs/shared/x.png",
    );
  });

  it("treats site-absolute path as relative to user root", () => {
    expect(resolveMarkdownImageSrc("/photos/a.jpg", "docs/note.md")).toBe(
      "/api/v1/files/photos/a.jpg",
    );
  });

  it("passes through https URLs untouched", () => {
    expect(
      resolveMarkdownImageSrc("https://example.com/x.png", "docs/note.md"),
    ).toBe("https://example.com/x.png");
  });

  it("passes through http URLs untouched", () => {
    expect(resolveMarkdownImageSrc("http://example.com/x.png", "note.md")).toBe(
      "http://example.com/x.png",
    );
  });

  it("passes through data: image URLs (raster only)", () => {
    expect(
      resolveMarkdownImageSrc("data:image/png;base64,iVBOR...", "note.md"),
    ).toBe("data:image/png;base64,iVBOR...");
    expect(
      resolveMarkdownImageSrc("data:image/jpeg;base64,/9j/...", "note.md"),
    ).toBe("data:image/jpeg;base64,/9j/...");
    expect(
      resolveMarkdownImageSrc("data:image/webp;base64,UklG...", "note.md"),
    ).toBe("data:image/webp;base64,UklG...");
  });

  it("rewrites data:image/svg+xml as relative (SVG can carry script)", () => {
    // SVG data URLs MUST NOT pass through — they execute scripts via
    // <script> / event handlers when loaded.
    const out = resolveMarkdownImageSrc(
      "data:image/svg+xml;base64,PHN2Zy8+",
      "note.md",
    );
    expect(out.startsWith("data:")).toBe(false);
  });

  it("rewrites data:text/html as relative (not an image)", () => {
    const out = resolveMarkdownImageSrc(
      "data:text/html,<script>alert(1)</script>",
      "note.md",
    );
    expect(out.startsWith("data:")).toBe(false);
  });

  it("passes through blob URLs untouched", () => {
    expect(resolveMarkdownImageSrc("blob:https://x/abc", "note.md")).toBe(
      "blob:https://x/abc",
    );
  });

  it("URL-encodes path segments", () => {
    expect(
      resolveMarkdownImageSrc("attachments/写真.jpg", "koto.md/2026-04-25.md"),
    ).toBe("/api/v1/files/koto.md/attachments/%E5%86%99%E7%9C%9F.jpg");
  });

  it("encodes spaces in segment", () => {
    expect(resolveMarkdownImageSrc("attachments/my photo.jpg", "note.md")).toBe(
      "/api/v1/files/attachments/my%20photo.jpg",
    );
  });

  it("returns input unchanged when src is empty", () => {
    expect(resolveMarkdownImageSrc("", "note.md")).toBe("");
  });

  it("does not escape above the user's root", () => {
    // Two `..` from a top-level file would walk above root; we drop the
    // attempt to escape, leaving just the trailing segment.
    expect(resolveMarkdownImageSrc("../../etc/passwd", "note.md")).toBe(
      "/api/v1/files/etc/passwd",
    );
  });

  it("handles a deep file path correctly", () => {
    expect(resolveMarkdownImageSrc("img.png", "year/2026/04/25/diary.md")).toBe(
      "/api/v1/files/year/2026/04/25/img.png",
    );
  });
});

describe("createMarkdownRenderer", () => {
  it("rewrites image src in rendered HTML", () => {
    const renderer = createMarkdownRenderer("koto.md/2026-04-25.md");
    const html = renderer.render("- 21:47:15 ![](attachments/abc.jpg)\n");
    expect(html).toContain('src="/api/v1/files/koto.md/attachments/abc.jpg"');
  });

  it("leaves http URLs untouched in rendered HTML", () => {
    const renderer = createMarkdownRenderer("note.md");
    const html = renderer.render("![](https://example.com/x.png)");
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("forces external links to open in a new tab", () => {
    const renderer = createMarkdownRenderer("note.md");
    const html = renderer.render("[link](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("strips non-http link href schemes", () => {
    // markdown-it accepts ftp:// as a link; we only allow http(s) and mailto.
    const renderer = createMarkdownRenderer("note.md");
    const html = renderer.render("[bad](ftp://example.com/x)");
    expect(html).not.toContain('href="ftp:');
  });
});
