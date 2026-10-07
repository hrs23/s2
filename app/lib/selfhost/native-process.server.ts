import path from "node:path";

interface NativeWritable {
  write(chunk: string): unknown;
}

interface NativeProcessSource {
  cwd(): string;
  readonly stdout: NativeWritable;
  readonly stderr: NativeWritable;
}

export function captureNativeProcess(source: NativeProcessSource = process) {
  const rootDir = source.cwd();
  return {
    clientDir: path.join(rootDir, "build/client"),
    serverBuildDir: path.join(rootDir, "build/server"),
    stdout: source.stdout,
    stderr: source.stderr,
  };
}
