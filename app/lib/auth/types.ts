// Shared auth type definitions — single canonical source.
// Used by both client and server code (no .server suffix).

/** Access levels ordered by privilege (cumulative: write implies read). */
export type AccessLevel = "read" | "write";

export interface AccessPathRow {
  path: string;
  access: AccessLevel;
}

export type AuthContext =
  | { type: "user"; user_id: string }
  | {
      type: "token";
      token_id: string;
      user_id: string;
      base_path: string;
      can_delegate: boolean;
      access_paths: AccessPathRow[];
      /**
       * RFC 8707 audience binding.
       *
       * - OAuth-issued tokens carry the resource indicator from the
       *   authorization request (e.g. `https://s2.example.com/mcp`).
       * - Legacy user-issued tokens (REST / WebDAV) have `null` —
       *   they were minted before audience binding existed.
       *
       * Audience-protected gateways (currently `/mcp`) MUST reject any
       * token whose `resource` does not equal the canonical request URI.
       */
      resource: string | null;
    };
