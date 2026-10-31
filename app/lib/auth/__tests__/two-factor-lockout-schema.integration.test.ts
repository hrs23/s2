import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const BACKFILL_MIGRATION =
  "20261031171329_two_factor_lockout_counter_default.sql";
const MAX_FAILED_ATTEMPTS = 10;

let db: PGlite;

async function applyMigrations(files: string[]): Promise<void> {
  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
    const up = raw
      .split("-- migrate:down")[0]
      .replace(/^--\s*migrate:up\s*\n?/m, "")
      .trim();
    if (up) await db.exec(up);
  }
}

beforeAll(async () => {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const cut = files.indexOf(BACKFILL_MIGRATION);
  if (cut <= 0) throw new Error(`${BACKFILL_MIGRATION} not found`);

  db = new PGlite();
  await applyMigrations(files.slice(0, cut));
  await db.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ('u_legacy', 'Legacy', 'legacy@example.com', true)`,
  );
  await db.query(
    `INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId", verified, "failedVerificationCount")
     VALUES ('tf_legacy', 'secret', 'codes', 'u_legacy', true, NULL)`,
  );
  await applyMigrations(files.slice(cut));
});

afterAll(async () => {
  await db.close();
});

describe("twoFactor.failedVerificationCount after upgrade", () => {
  it("backfills a NULL counter on a pre-existing row to 0", async () => {
    const { rows } = await db.query<{ count: number | null }>(
      `SELECT "failedVerificationCount" AS count FROM "twoFactor" WHERE id = 'tf_legacy'`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("lets an atomic increment on the legacy row reach the lockout threshold", async () => {
    let count: number | null | undefined;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const { rows } = await db.query<{ count: number | null }>(
        `UPDATE "twoFactor" SET "failedVerificationCount" = "failedVerificationCount" + 1
         WHERE id = 'tf_legacy' RETURNING "failedVerificationCount" AS count`,
      );
      count = rows[0]?.count;
    }
    expect(count).toBe(MAX_FAILED_ATTEMPTS);
  });

  it("defaults new rows to 0 and rejects NULL", async () => {
    await db.query(
      `INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId")
       VALUES ('tf_new', 'secret', 'codes', 'u_legacy')`,
    );
    const { rows } = await db.query<{ count: number | null }>(
      `SELECT "failedVerificationCount" AS count FROM "twoFactor" WHERE id = 'tf_new'`,
    );
    expect(rows[0]?.count).toBe(0);

    await expect(
      db.query(
        `UPDATE "twoFactor" SET "failedVerificationCount" = NULL WHERE id = 'tf_new'`,
      ),
    ).rejects.toThrow();
  });
});
