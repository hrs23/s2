// /internal/* is the cookie-only WebUI surface (Bearer rejected at the
// middleware) and is OpenAPI-exempt.

const INTERNAL_PREFIX = "/internal/";
const INTERNAL_ROOT = "/internal";

export function isInternal(path: string): boolean {
  return path === INTERNAL_ROOT || path.startsWith(INTERNAL_PREFIX);
}
