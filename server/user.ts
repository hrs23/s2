import { randomBytes } from "node:crypto";
import {
  createSelfHostUser,
  setSelfHostUserPassword,
} from "~/lib/selfhost/user-bootstrap.server";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "create" && command !== "set-password") {
    usage();
    process.exit(command ? 1 : 0);
  }

  const options = parseArgs(args);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (command === "create") {
    const generatedPassword = options.password ? undefined : generatePassword();
    const password = options.password ?? generatedPassword;
    const result = await createSelfHostUser({
      databaseUrl,
      email: requiredOption(options, "email"),
      password,
      name: options.name,
    });

    process.stdout.write(
      `${result.firstUser ? "Created initial user" : "Created user"} ${result.email} (${result.id})`,
    );
    process.stdout.write("\n");
    if (generatedPassword) {
      printGeneratedPassword(generatedPassword);
    }
    return;
  }

  const generatedPassword = options.password ? undefined : generatePassword();
  const password = options.password ?? generatedPassword;
  const result = await setSelfHostUserPassword({
    databaseUrl,
    email: requiredOption(options, "email"),
    password,
  });
  process.stdout.write(`Updated password for ${result.email} (${result.id})`);
  process.stdout.write("\n");
  if (generatedPassword) {
    printGeneratedPassword(generatedPassword);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

function requiredOption(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function usage(): void {
  process.stdout.write(`Usage:
  pnpm user create --email owner@example.com
  pnpm user create --email owner@example.com --password 'change-me-now'
  pnpm user set-password --email owner@example.com
  pnpm user set-password --email owner@example.com --password 'change-me-now'
`);
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

function printGeneratedPassword(password: string): void {
  process.stdout.write(`Generated password: ${password}\n`);
  process.stdout.write("Store it now. It will not be shown again.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
