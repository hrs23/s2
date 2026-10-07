import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "./range-parser";

describe("parseRangeHeader", () => {
  describe("ignore cases (RFC 9110 §14.2: MUST ignore unrecognized range-unit)", () => {
    it("returns ignore when header is null", () => {
      expect(parseRangeHeader(null)).toEqual({ kind: "ignore" });
    });

    it("returns ignore when header is empty string", () => {
      expect(parseRangeHeader("")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for non-bytes range-unit", () => {
      expect(parseRangeHeader("chars=0-1")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for missing range-unit", () => {
      expect(parseRangeHeader("0-99")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for malformed range (bytes=abc)", () => {
      expect(parseRangeHeader("bytes=abc")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for bytes= with no range-set", () => {
      expect(parseRangeHeader("bytes=")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for bytes=- (no digits either side)", () => {
      expect(parseRangeHeader("bytes=-")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for last-pos < first-pos (RFC: invalid range-spec)", () => {
      expect(parseRangeHeader("bytes=10-5")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for non-numeric first-pos", () => {
      expect(parseRangeHeader("bytes=x-10")).toEqual({ kind: "ignore" });
    });

    it("returns ignore for non-numeric last-pos", () => {
      expect(parseRangeHeader("bytes=0-x")).toEqual({ kind: "ignore" });
    });
  });

  describe("multi-range (v1: fallback to 200 full body)", () => {
    it("detects multiple ranges", () => {
      expect(parseRangeHeader("bytes=0-10,20-30")).toEqual({ kind: "multi" });
    });

    it("detects multi-range with OWS around comma", () => {
      expect(parseRangeHeader("bytes=0-10 , 20-30")).toEqual({ kind: "multi" });
    });

    it("detects three or more ranges", () => {
      expect(parseRangeHeader("bytes=0-10,20-30,40-50")).toEqual({
        kind: "multi",
      });
    });
  });

  describe("bounded range bytes=N-M", () => {
    it("parses simple bounded range", () => {
      expect(parseRangeHeader("bytes=0-99")).toEqual({
        kind: "ok",
        spec: { type: "bounded", firstByte: 0, lastByte: 99 },
      });
    });

    it("parses single-byte range bytes=5-5", () => {
      expect(parseRangeHeader("bytes=5-5")).toEqual({
        kind: "ok",
        spec: { type: "bounded", firstByte: 5, lastByte: 5 },
      });
    });

    it("parses large bounded range", () => {
      expect(parseRangeHeader("bytes=1000000-9999999")).toEqual({
        kind: "ok",
        spec: { type: "bounded", firstByte: 1000000, lastByte: 9999999 },
      });
    });
  });

  describe("open-ended range bytes=N-", () => {
    it("parses bytes=0-", () => {
      expect(parseRangeHeader("bytes=0-")).toEqual({
        kind: "ok",
        spec: { type: "from", firstByte: 0 },
      });
    });

    it("parses bytes=100-", () => {
      expect(parseRangeHeader("bytes=100-")).toEqual({
        kind: "ok",
        spec: { type: "from", firstByte: 100 },
      });
    });
  });

  describe("suffix range bytes=-N", () => {
    it("parses suffix range bytes=-10", () => {
      expect(parseRangeHeader("bytes=-10")).toEqual({
        kind: "ok",
        spec: { type: "suffix", suffixLength: 10 },
      });
    });

    it("parses large suffix range", () => {
      expect(parseRangeHeader("bytes=-1048576")).toEqual({
        kind: "ok",
        spec: { type: "suffix", suffixLength: 1048576 },
      });
    });

    it("accepts bytes=-0 syntactically (FileService resolves to 416)", () => {
      expect(parseRangeHeader("bytes=-0")).toEqual({
        kind: "ok",
        spec: { type: "suffix", suffixLength: 0 },
      });
    });
  });

  describe("case-insensitive range-unit", () => {
    it("accepts Bytes= (mixed case)", () => {
      expect(parseRangeHeader("Bytes=0-99")).toEqual({
        kind: "ok",
        spec: { type: "bounded", firstByte: 0, lastByte: 99 },
      });
    });

    it("accepts BYTES= (upper case)", () => {
      expect(parseRangeHeader("BYTES=0-99")).toEqual({
        kind: "ok",
        spec: { type: "bounded", firstByte: 0, lastByte: 99 },
      });
    });
  });
});
