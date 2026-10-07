import type { IncomingHttpHeaders } from "node:http";

export function createSelfHostRequestHeaders(
  incoming: IncomingHttpHeaders,
  remoteAddress: string | undefined,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (key.toLowerCase() === "x-s2-client-ip") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (remoteAddress) {
    headers.set("x-s2-client-ip", remoteAddress);
  }
  return headers;
}
