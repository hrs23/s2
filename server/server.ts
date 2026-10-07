import { readdir, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "react-router";
import { startMaintenanceScheduler } from "~/lib/cron/maintenance-scheduler.server";
import { handleDavRequest } from "~/lib/gateway/dav";
import { evaluateEdge } from "~/lib/gateway/middleware";
import { readSelfHostConfig } from "~/lib/selfhost/config.server";
import { captureNativeProcess } from "~/lib/selfhost/native-process.server";
import { createSelfHostRequestHeaders } from "~/lib/selfhost/request-headers.server";
import {
  createSelfHostLoadContext,
  createSelfHostRuntime,
} from "~/lib/selfhost/runtime.server";

const nativeProcess = captureNativeProcess();
const config = readSelfHostConfig();
const runtime = createSelfHostRuntime(config);
const mode = process.env.NODE_ENV ?? "production";
const build = await loadServerBuild(nativeProcess.serverBuildDir);
const requestHandler = createRequestHandler(() => Promise.resolve(build), mode);
const clientDir = nativeProcess.clientDir;

const server = createServer(async (req, res) => {
  try {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const request = toWebRequest(req, abort.signal);
    const staticResponse = await maybeServeStatic(request);
    const response = staticResponse ?? (await handleDynamicRequest(request));
    await sendWebResponse(res, response, request.method === "HEAD");
  } catch (error) {
    nativeProcess.stderr.write(
      `${error instanceof Error ? error.stack : error}\n`,
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

const maintenance = startMaintenanceScheduler(runtime.env, {
  enabled: config.maintenanceEnabled,
  cron: config.maintenanceCron,
});

server.listen(config.port, () => {
  nativeProcess.stdout.write(`S2 self-host listening on ${config.appUrl}\n`);
  if (config.maintenanceEnabled) {
    nativeProcess.stdout.write(
      `Daily maintenance scheduled (${config.maintenanceCron} UTC)\n`,
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    maintenance.stop();
    server.close(() => process.exit(0));
  });
}

async function handleDynamicRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const context = createSelfHostLoadContext(runtime);
  if (url.pathname === "/dav" || url.pathname.startsWith("/dav/")) {
    return handleDavRequest(request, context);
  }
  const blocked = evaluateEdge(request, url.pathname, config.appUrl);
  if (blocked) return blocked;
  return requestHandler(request, context);
}

async function loadServerBuild(serverDir: string) {
  const indexPath = path.join(serverDir, "index.js");
  try {
    const info = await stat(indexPath);
    if (info.isFile()) {
      return import(pathToFileURL(indexPath).href);
    }
  } catch {
    // Fall through to the hashed server-build layout.
  }

  const assetsDir = path.join(serverDir, "assets");
  const entries = await readdir(assetsDir);
  const serverBuild = entries.find(
    (entry) => entry.startsWith("server-build-") && entry.endsWith(".js"),
  );
  if (!serverBuild) {
    throw new Error("React Router server build not found");
  }
  return import(pathToFileURL(path.join(assetsDir, serverBuild)).href);
}

function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const host = req.headers.host ?? `localhost:${config.port}`;
  const target = req.url ?? "/";
  const url = new URL(config.appUrl);
  const queryIndex = target.indexOf("?");
  const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
  url.pathname = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  url.search = queryIndex === -1 ? "" : target.slice(queryIndex);
  if (!req.headers.host) {
    url.host = host;
  }
  const headers = createSelfHostRequestHeaders(
    req.headers,
    req.socket.remoteAddress,
  );

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function maybeServeStatic(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname === "/" || pathname.endsWith("/")) return null;

  const filePath = path.resolve(clientDir, `.${pathname}`);
  const relative = path.relative(clientDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const file = await readFile(filePath);
    return new Response(file, {
      headers: {
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300",
        "Content-Type": contentType(filePath),
      },
    });
  } catch {
    return null;
  }
}

async function sendWebResponse(
  res: ServerResponse,
  response: Response,
  omitBody: boolean,
): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() !== "set-cookie") {
      res.setHeader(key, value);
    }
  }
  if (setCookie.length > 0) {
    res.setHeader("Set-Cookie", setCookie);
  }
  if (omitBody || !response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    res,
  );
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
