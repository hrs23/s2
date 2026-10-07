// Shared OAuth 2.1 types.
// Pure type definitions used by both client and server; no .server suffix.

/**
 * OAuth client authentication method (RFC 7591).
 * - "none": public client (PKCE only, no secret)
 * - "client_secret_basic": confidential client (HTTP Basic with client_id:client_secret)
 */
export type TokenEndpointAuthMethod = "none" | "client_secret_basic";

/** OAuth scope vocabulary: the resource namespace an app requests. */
export type OAuthScope = "files";

/** PKCE code_challenge method. S256 is required in OAuth 2.1. */
export type CodeChallengeMethod = "S256";

/**
 * OAuth error response (RFC 6749 §5.2 + RFC 7591 §3.2.2 + RFC 8707 §2).
 */
type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "invalid_target" // RFC 8707 §2: invalid resource indicator
  // RFC 7591 §3.2.2: DCR-specific errors
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  // Registration quota (abuse controls)
  | "too_many_requests";

export interface OAuthError {
  error: OAuthErrorCode;
  error_description?: string;
}

/** Successful token endpoint response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}
