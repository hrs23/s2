// Token generation logic
// Generates s2_ tokens and SHA-256 hashing

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a random string of n characters from the given alphabet using crypto.getRandomValues.
 * Uses rejection sampling to avoid modulo bias.
 */
export function randomString(alphabet: string, length: number): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // Truncate upper bound to a multiple of alphabet.length
  let result = "";
  while (result.length < length) {
    const buf = new Uint8Array(length * 2); // Generate extra to account for rejections
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (result.length >= length) break;
      if (byte < max) {
        result += alphabet[byte % alphabet.length];
      }
    }
  }
  return result;
}

/** Generate a 35-character token with s2_ prefix */
export function generateS2Token(): string {
  return `s2_${randomString(BASE62, 32)}`;
}

/** Hash an s2_ token with SHA-256 and return hex string */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
