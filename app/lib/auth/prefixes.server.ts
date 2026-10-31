// /internal/* is the cookie-only WebUI surface (Bearer rejected at the
// middleware) and is OpenAPI-exempt.

const INTERNAL_PREFIX = "/internal/";
const INTERNAL_ROOT = "/internal";

function canonicalPath(path: string): string {
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

export function isInternal(path: string): boolean {
  const canonical = canonicalPath(path);
  return canonical === INTERNAL_ROOT || canonical.startsWith(INTERNAL_PREFIX);
}
