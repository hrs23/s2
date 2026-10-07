import { runDailyMaintenance } from "~/lib/cron/daily-maintenance.server";
import { readSelfHostConfig } from "~/lib/selfhost/config.server";
import { createSelfHostRuntime } from "~/lib/selfhost/runtime.server";

async function main(): Promise<void> {
  const config = readSelfHostConfig();
  const runtime = createSelfHostRuntime(config);
  process.stdout.write("Running daily maintenance…\n");
  await runDailyMaintenance(runtime.env);
  process.stdout.write("Daily maintenance finished.\n");
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : error}\n`,
  );
  process.exit(1);
});
