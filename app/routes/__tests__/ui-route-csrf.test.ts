// UI route CSRF structural guard.
//
// React Router v7's built-in CSRF check is disabled via allowedActionOrigins
// in react-router.config.ts (it misfires behind reverse proxies when Host /
// X-Forwarded-Host drift from Origin). checkSameOrigin from
// app/lib/auth/origin-check.server.ts is the single source of truth for
// login-CSRF defence and MUST be called from every UI route action.
//
// This test enumerates .tsx route files under app/routes/ that export an
// action and fails if any of them doesn't reference checkSameOrigin. It's the
// safety net that would have caught /login/verify if RR hadn't been
// catching it for us.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(process.cwd(), "app", "routes");

function uiRouteFilesWithAction(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(ROUTES_DIR, name))
    .filter((path) => {
      const src = readFileSync(path, "utf8");
      return /export\s+(async\s+)?function\s+action\b|export\s+const\s+action\s*=/.test(
        src,
      );
    });
}

describe("UI route CSRF guard", () => {
  it("every UI route action references checkSameOrigin", () => {
    const files = uiRouteFilesWithAction();
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((path) => {
      const src = readFileSync(path, "utf8");
      return !/checkSameOrigin/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
