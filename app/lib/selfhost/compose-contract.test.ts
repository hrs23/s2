import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(
  path.join(process.cwd(), "selfhost/compose.yaml"),
  "utf8",
);

describe("self-host Compose contract", () => {
  it("requires an operator-provided Postgres password", () => {
    expect(compose).toMatch(
      /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?set POSTGRES_PASSWORD in \.env\}/,
    );
    expect(compose).toMatch(
      /DATABASE_URL: postgres:\/\/postgres:\$\{POSTGRES_PASSWORD:\?set POSTGRES_PASSWORD in \.env\}@db:5432\/s2\?sslmode=disable/,
    );
    expect(compose).not.toContain("POSTGRES_PASSWORD: postgres");
  });

  it("only publishes the app on loopback", () => {
    expect(compose).toMatch(/"127\.0\.0\.1:\$\{S2_PORT:-3000\}:3000"/);
  });
});
