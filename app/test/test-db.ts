// Test DbClient backed by PGlite (in-memory WASM PostgreSQL).
// Each call creates a fresh isolated instance with all migrations applied.
// No Docker/Postgres service needed.

import type { DbClient } from "~/lib/db/client.server";
import { createPGliteDb } from "./pglite-db";

/**
 * Creates a fresh PGlite in-memory database with all migrations applied.
 * Each call is fully isolated.
 */
export async function createTestDb(): Promise<DbClient> {
  return createPGliteDb();
}
