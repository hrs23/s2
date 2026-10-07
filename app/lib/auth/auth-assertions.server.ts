// Cross-service runtime assertions on AuthContext.
// Lives in .server.ts because callers are all server-side services.

import type { AuthContext } from "./types";

export function assertServiceUserMatches(
  auth: AuthContext,
  containerUserId: string,
): void {
  if (auth.user_id !== containerUserId) {
    throw new Error(
      `service user mismatch: container=${containerUserId} auth=${auth.user_id}`,
    );
  }
}
