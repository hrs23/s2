// Web Crypto API based ULID generation
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateUlidForApi(): string {
  const now = Date.now();
  let id = "";
  let t = now;
  for (let i = 9; i >= 0; i--) {
    id = ENCODING[t % 32] + id;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  for (const byte of bytes) {
    id += ENCODING[byte % 32];
  }
  return id;
}

/**
 * Random opaque ID: `<prefix><hex>` where hex is a UUIDv4 without dashes,
 * truncated to `length` chars (default 16, max 32).
 */
export function newId(prefix = "", length = 16): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, length)}`;
}
