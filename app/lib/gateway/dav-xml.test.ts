import { describe, expect, it } from "vitest";
import {
  escapeXml,
  lockResponseXml,
  multiStatusXml,
  propfindResponse,
} from "./dav-xml";

describe("escapeXml", () => {
  it("escapes ampersand", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than", () => {
    expect(escapeXml("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes double quote", () => {
    expect(escapeXml('"value"')).toBe("&quot;value&quot;");
  });

  it("returns plain string unchanged", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
});

describe("propfindResponse", () => {
  it("collection response contains resourcetype collection", () => {
    const xml = propfindResponse({
      href: "/dav/docs/",
      isCollection: true,
      size: 0,
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    expect(xml).toContain("<D:collection/>");
    expect(xml).toContain("<D:href>/dav/docs/</D:href>");
  });

  it("file response contains getcontentlength", () => {
    const xml = propfindResponse({
      href: "/dav/docs/foo.txt",
      isCollection: false,
      size: 1234,
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    expect(xml).toContain("<D:getcontentlength>1234</D:getcontentlength>");
    expect(xml).not.toContain("<D:collection/>");
  });

  it("displayname is the last path segment", () => {
    const xml = propfindResponse({
      href: "/dav/docs/readme.md",
      isCollection: false,
      size: 10,
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    expect(xml).toContain("<D:displayname>readme.md</D:displayname>");
  });

  it("includes getcontenttype for files", () => {
    const xml = propfindResponse({
      href: "/dav/image.png",
      isCollection: false,
      size: 100,
      lastModified: "",
      contentType: "image/png",
    });
    expect(xml).toContain("<D:getcontenttype>image/png</D:getcontenttype>");
  });

  it("defaults contentType to application/octet-stream", () => {
    const xml = propfindResponse({
      href: "/dav/file.bin",
      isCollection: false,
      size: 0,
      lastModified: "",
    });
    expect(xml).toContain(
      "<D:getcontenttype>application/octet-stream</D:getcontenttype>",
    );
  });

  it("includes getetag when contentVersion > 0", () => {
    const xml = propfindResponse({
      href: "/dav/file.txt",
      isCollection: false,
      size: 10,
      lastModified: "",
      contentVersion: 3,
    });
    expect(xml).toContain('<D:getetag>"3"</D:getetag>');
  });

  it("omits getetag when contentVersion is 0", () => {
    const xml = propfindResponse({
      href: "/dav/file.txt",
      isCollection: false,
      size: 10,
      lastModified: "",
      contentVersion: 0,
    });
    expect(xml).not.toContain("<D:getetag>");
  });

  it("includes supportedlock with exclusive and shared entries", () => {
    const xml = propfindResponse({
      href: "/dav/file.txt",
      isCollection: false,
      size: 0,
      lastModified: "",
    });
    expect(xml).toContain("<D:supportedlock>");
    expect(xml).toContain("<D:exclusive/>");
    expect(xml).toContain("<D:shared/>");
  });

  it("escapes special chars in href", () => {
    const xml = propfindResponse({
      href: '/dav/a&b/"test"',
      isCollection: false,
      size: 0,
      lastModified: "",
    });
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
  });
});

describe("multiStatusXml", () => {
  it("wraps responses in multistatus element", () => {
    const xml = multiStatusXml([
      "<D:response>a</D:response>",
      "<D:response>b</D:response>",
    ]);
    expect(xml).toContain('<D:multistatus xmlns:D="DAV:">');
    expect(xml).toContain("<D:response>a</D:response>");
    expect(xml).toContain("<D:response>b</D:response>");
  });

  it("includes XML declaration", () => {
    const xml = multiStatusXml([]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });
});

describe("lockResponseXml", () => {
  it("contains activelock with token and href", () => {
    const xml = lockResponseXml("/dav/file.txt", "abc-123");
    expect(xml).toContain("<D:activelock>");
    expect(xml).toContain("<D:href>urn:uuid:abc-123</D:href>");
    expect(xml).toContain("<D:href>/dav/file.txt</D:href>");
    expect(xml).toContain("<D:write/>");
    expect(xml).toContain("<D:exclusive/>");
    expect(xml).toContain("Second-3600");
  });

  it("escapes special chars in href", () => {
    const xml = lockResponseXml("/dav/a&b", "token-1");
    expect(xml).toContain("/dav/a&amp;b");
  });
});
