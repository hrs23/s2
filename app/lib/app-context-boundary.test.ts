import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DIRECT_ENV_PATTERN = "context.runtime" + ".env";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "node_modules") continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
      files.push(path);
    }
  }
  return files;
}

test("Runtime env reads stay behind the load-context helper", () => {
  const actual = new Map<string, number>();
  for (const file of sourceFiles(process.cwd())) {
    const src = readFileSync(file, "utf8");
    const count = src.split(DIRECT_ENV_PATTERN).length - 1;
    if (count > 0) {
      actual.set(relative(process.cwd(), file), count);
    }
  }

  expect(actual).toEqual(new Map());
});
