// Guardrail against a regression where a new file under app/routes/
// was added and its loader called by the dashboard, but the entry was never
// wired into routes.ts. The runtime answered 404 in prod and the existing
// E2E only asserted URL transition, so the regression shipped.
//
// This file-presence check costs nothing and refuses the next instance
// silently.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(__dirname, "routes");
const ROUTES_CONFIG = join(__dirname, "routes.ts");

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !/\.test\.tsx?$/.test(name))
    .sort();
}

describe("app/routes.ts", () => {
  it("references every file under app/routes/ (except *.test.*)", () => {
    const config = readFileSync(ROUTES_CONFIG, "utf8");
    const orphaned = listRouteFiles().filter(
      (file) => !config.includes(`routes/${file}"`),
    );
    expect(orphaned, "route files added but never wired in routes.ts").toEqual(
      [],
    );
  });
});
