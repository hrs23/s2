import fs from "node:fs";
import path from "node:path";

const E2E_AUTH_SECRET = "e2e-test-auth-secret-fixed";

const DEV_VARS_PATH = path.resolve(process.cwd(), ".dev.vars");
let generated = false;

/**
 * Generates .dev.vars with dummy test values if it does not exist.
 * Called at the top level of playwright.config.ts so the file is in place
 * before the webServer (Node dev server) starts.
 *
 * An existing .dev.vars is never touched.
 */
export function ensureDevVars() {
  if (fs.existsSync(DEV_VARS_PATH)) return;
  fs.writeFileSync(
    DEV_VARS_PATH,
    [
      `AUTH_SECRET=${E2E_AUTH_SECRET}`,
      "APP_URL=http://localhost:8888",
    ].join("\n"),
  );
  generated = true;
  console.log("[E2E] Generated .dev.vars (for tests)");
}

/** Remove the .dev.vars generated for tests. */
export function cleanupDevVars() {
  if (generated && fs.existsSync(DEV_VARS_PATH)) {
    fs.unlinkSync(DEV_VARS_PATH);
    console.log("[E2E] Removed .dev.vars");
  }
}
