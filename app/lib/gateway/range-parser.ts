// Pure HTTP `Range` header parser. RFC 9110 §14.1.
// Returns a syntactic ByteRangeSpec; resolution against the actual file size
// (clamping, 416 decision, If-Range comparison) happens in FileService.

import type { ByteRangeSpec } from "~/lib/files/file-service.server";

export type ParseRangeResult =
  | { kind: "ok"; spec: ByteRangeSpec }
  | { kind: "multi" } // multiple ranges — v1 falls back to 200 full body
  | { kind: "ignore" }; // missing, malformed, or non-bytes unit — RFC: MUST ignore

const INT_RANGE_RE = /^(\d+)-(\d*)$/;
const SUFFIX_RANGE_RE = /^-(\d+)$/;

export function parseRangeHeader(headerValue: string | null): ParseRangeResult {
  if (headerValue === null) return { kind: "ignore" };

  const trimmed = headerValue.trim();
  if (trimmed === "") return { kind: "ignore" };

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) return { kind: "ignore" };

  const unit = trimmed.slice(0, eqIdx).trim().toLowerCase();
  if (unit !== "bytes") return { kind: "ignore" };

  const rangeSet = trimmed.slice(eqIdx + 1).trim();
  if (rangeSet === "") return { kind: "ignore" };

  const parts = rangeSet.split(",").map((s) => s.trim());
  if (parts.length > 1) return { kind: "multi" };

  const part = parts[0];
  if (part === "") return { kind: "ignore" };

  const suffix = SUFFIX_RANGE_RE.exec(part);
  if (suffix) {
    const suffixLength = Number(suffix[1]);
    if (!Number.isFinite(suffixLength)) return { kind: "ignore" };
    return { kind: "ok", spec: { type: "suffix", suffixLength } };
  }

  const intRange = INT_RANGE_RE.exec(part);
  if (intRange) {
    const firstByte = Number(intRange[1]);
    if (!Number.isFinite(firstByte)) return { kind: "ignore" };
    if (intRange[2] === "") {
      return { kind: "ok", spec: { type: "from", firstByte } };
    }
    const lastByte = Number(intRange[2]);
    if (!Number.isFinite(lastByte)) return { kind: "ignore" };
    if (lastByte < firstByte) return { kind: "ignore" };
    return { kind: "ok", spec: { type: "bounded", firstByte, lastByte } };
  }

  return { kind: "ignore" };
}
