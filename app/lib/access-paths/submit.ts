import type { AccessPath } from "~/lib/api";

/** Client-side default that surfaces an empty editor as
 *  "all paths under base_path" (canonical root form).
 *  The server rejects `access_paths.length === 0`, so every
 *  client must send this single-row canonical form when the user does
 *  not narrow the scope. Surfaces: OAuth consent, Token create/edit,
 *  Connection edit. */
export function accessPathsForSubmit(paths: AccessPath[]): AccessPath[] {
  return paths.length > 0 ? paths : [{ path: "", access: "write" }];
}
