import fs from "node:fs";
import path from "node:path";

/** Load `.dev.vars` into `process.env` without overriding existing values. */
export function loadDevVars(cwd = process.cwd()): void {
  const file = path.join(cwd, ".dev.vars");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env) || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}
