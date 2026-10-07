// OAuthClientRepository: CRUD for the oauth_clients table.
//
// Every client is registered via Dynamic Client Registration (RFC 7591);
// there is no pre-registration or verification.

import type { DbClient } from "~/lib/db/client.server";
import type { TokenEndpointAuthMethod } from "./types";

export interface OAuthClientRow {
  id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  client_secret_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RegisterClientParams {
  id: string;
  clientName: string;
  redirectUris: ReadonlyArray<string>;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientSecretHash: string | null;
  metadata?: Record<string, unknown>;
}

export class OAuthClientRepository {
  constructor(private db: DbClient) {}

  async findById(clientId: string): Promise<OAuthClientRow | null> {
    return this.db.queryOne<OAuthClientRow>(
      `SELECT id, client_name, redirect_uris, token_endpoint_auth_method,
              client_secret_hash, metadata, created_at
       FROM oauth_clients
       WHERE id = $1`,
      [clientId],
    );
  }

  /**
   * Insert a Dynamic Client Registration (RFC 7591) row.
   * Every client comes through DCR (flat DCR model).
   */
  async registerDcr(params: RegisterClientParams): Promise<void> {
    await this.db.execute(
      `INSERT INTO oauth_clients
         (id, client_name, redirect_uris, token_endpoint_auth_method,
          client_secret_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        params.id,
        params.clientName,
        params.redirectUris,
        params.tokenEndpointAuthMethod,
        params.clientSecretHash,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
  }

  /**
   * Hard-delete DCR clients that have no grants and are older than `olderThanDays`.
   *
   * Rows are physically deleted rather than soft-deleted. Deleting a client
   * removes its related grants, so a logically-deleted intermediate state
   * (client kept but no grants) is meaningless. The 30-day grace is kept so a
   * freshly registered client with no grant yet is not deleted immediately.
   *
   * Returns the number of rows physically deleted.
   */
  async cleanupUnusedDcrClients(olderThanDays: number): Promise<number> {
    const result = await this.db.execute(
      `DELETE FROM oauth_clients
       WHERE created_at < now() - ($1 || ' days')::INTERVAL
         AND NOT EXISTS (
           SELECT 1 FROM oauth_grants WHERE oauth_client_id = oauth_clients.id
         )`,
      [String(olderThanDays)],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Count successful DCR registrations within the trailing window.
   * Used to enforce the global registration quota (DCR abuse controls).
   */
  async countRecentRegistrations(sinceMillisAgo: number): Promise<number> {
    const since = new Date(Date.now() - sinceMillisAgo).toISOString();
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM oauth_clients
       WHERE created_at >= $1`,
      [since],
    );
    return row?.count ?? 0;
  }
}
