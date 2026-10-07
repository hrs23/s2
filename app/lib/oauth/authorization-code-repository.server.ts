// AuthorizationCodeRepository: CRUD for the oauth_authorization_codes table.
//
// Short-lived codes for PKCE verification. At consent time scope / paths /
// base_path / resource are frozen (snapshot), and the grant is created or
// updated from that snapshot on code exchange.
//
// Codes are stored hashed. The plaintext code is only returned to the client
// and never persisted (prevents exchange attacks after a DB leak).

import { hashToken } from "~/lib/auth/token.server";
import type { DbClient } from "~/lib/db/client.server";
import type { CodeChallengeMethod, OAuthScope } from "./types";

export interface ConsentPathSnapshot {
  path: string;
  access: "read" | "write";
}

export interface AuthorizationCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: OAuthScope[];
  code_challenge: string;
  code_challenge_method: CodeChallengeMethod;
  base_path: string;
  consent_paths: ConsentPathSnapshot[];
  resource: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface CreateAuthorizationCodeParams {
  /** Plain code; the row stores only its hash. */
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  basePath: string;
  consentPaths: ReadonlyArray<ConsentPathSnapshot>;
  resource: string | null;
  expiresAt: string;
}

export class AuthorizationCodeRepository {
  constructor(private db: DbClient) {}

  async create(params: CreateAuthorizationCodeParams): Promise<void> {
    const codeHash = await hashToken(params.code);
    await this.db.execute(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, user_id, redirect_uri, scopes,
          code_challenge, code_challenge_method,
          base_path, consent_paths, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        codeHash,
        params.clientId,
        params.userId,
        params.redirectUri,
        params.scopes,
        params.codeChallenge,
        params.codeChallengeMethod,
        params.basePath,
        JSON.stringify(params.consentPaths),
        params.resource,
        params.expiresAt,
      ],
    );
  }

  /**
   * Atomically consume the authorization code: hash the presented code, mark
   * it used, and return its snapshot. Returns null if the code does not exist,
   * is already used, or has expired. Race-safe (UPDATE ... RETURNING).
   */
  async consume(plainCode: string): Promise<AuthorizationCodeRow | null> {
    const codeHash = await hashToken(plainCode);
    return this.db.queryOne<AuthorizationCodeRow>(
      `UPDATE oauth_authorization_codes
       SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING code_hash, client_id, user_id, redirect_uri, scopes,
                 code_challenge, code_challenge_method,
                 base_path, consent_paths, resource,
                 expires_at, used_at, created_at`,
      [codeHash],
    );
  }
}
