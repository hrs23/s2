// OAuthGrantRepository: CRUD for the oauth_grants table.
//
// Holds the details specific to grants issued via the OAuth flow.
// Together with the generic grants row it forms a single grant.
//
// There is no installation_id / device_label: multi-device is separated
// naturally by a per-install client_id (a separate client per DCR).

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";

export interface OAuthGrantRow {
  grant_id: string;
  user_id: string;
  oauth_client_id: string;
  oauth_requested_scopes: string[];
  resource: string | null;
}

export interface CreateOAuthGrantParams {
  grantId: string;
  userId: string;
  basePath: string;
  createdAt: string;
  oauthClientId: string;
  oauthRequestedScopes: ReadonlyArray<string>;
  resource: string | null;
}

export class OAuthGrantRepository {
  /**
   * Insert both rows that make up an OAuth grant: the generic
   * `grants` row and the OAuth-specific `oauth_grants` row. Mirrors
   * `TokenRepository.createToken` (which writes grants + user_grants
   * for user-issued grants) so callers stay symmetric.
   */
  async create(
    params: CreateOAuthGrantParams,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ($1, $2, $3, $4)`,
      [params.grantId, params.userId, params.basePath, params.createdAt],
    );
    await tx.execute(
      `INSERT INTO oauth_grants
         (grant_id, user_id, oauth_client_id, oauth_requested_scopes,
          resource)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.grantId,
        params.userId,
        params.oauthClientId,
        params.oauthRequestedScopes,
        params.resource,
      ],
    );
  }

  /**
   * Find an existing OAuth grant by (user, client). With flat DCR
   * a per-install client_id maps to a single grant per user — no installation
   * dimension needed.
   */
  async findByUserClient(
    userId: string,
    oauthClientId: string,
    tx: WithinUserTx,
  ): Promise<OAuthGrantRow | null> {
    return tx.queryOne<OAuthGrantRow>(
      `SELECT grant_id, user_id, oauth_client_id, oauth_requested_scopes,
              resource
       FROM oauth_grants
       WHERE user_id = $1 AND oauth_client_id = $2`,
      [userId, oauthClientId],
    );
  }

  async findById(
    grantId: string,
    tx: WithinUserTx,
  ): Promise<OAuthGrantRow | null> {
    return tx.queryOne<OAuthGrantRow>(
      `SELECT grant_id, user_id, oauth_client_id, oauth_requested_scopes,
              resource
       FROM oauth_grants WHERE grant_id = $1`,
      [grantId],
    );
  }

  /**
   * On re-consent, refresh the snapshot fields that change with the new
   * authorization request: requested scopes and resource (audience).
   * oauth_client_id is part of grant identity and never mutated.
   */
  async updateOnReconsent(
    grantId: string,
    params: {
      oauthRequestedScopes: ReadonlyArray<string>;
      resource: string | null;
    },
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `UPDATE oauth_grants
       SET oauth_requested_scopes = $1,
           resource = $2
       WHERE grant_id = $3`,
      [params.oauthRequestedScopes, params.resource, grantId],
    );
  }
}
