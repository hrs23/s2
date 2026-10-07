import path from "node:path";
import type { ServerBuild } from "react-router";
import { createRequestHandler } from "react-router";
import type { Plugin, ViteDevServer } from "vite";

const SERVER_BUILD_ID = "virtual:react-router/server-build";

interface SelfHostRuntime {
  appContext: unknown;
  env: Env;
}

async function loadRuntime(
  viteDevServer: ViteDevServer,
): Promise<SelfHostRuntime> {
  const root = viteDevServer.config.root;
  const { readDevSelfHostConfig } = await viteDevServer.ssrLoadModule(
    path.join(root, "app/lib/selfhost/dev-config.server.ts"),
  );
  const { createSelfHostRuntime } = await viteDevServer.ssrLoadModule(
    path.join(root, "app/lib/selfhost/runtime.server.ts"),
  );
  return createSelfHostRuntime(readDevSelfHostConfig());
}

/**
 * Node dev proxy: runs the self-host runtime
 * (Postgres + filesystem storage + in-memory auth storage).
 * Register this plugin before `reactRouter()` so its request middleware runs
 * first: React Router registers its own catch-all SSR handler in a returned
 * `configureServer` post-hook, and Vite runs post-hooks in plugin order. If
 * this plugin came later, React Router's handler would serve every request
 * with a load context missing the self-host `env`, so `getRuntimeEnv` would
 * throw "Runtime env missing from AppLoadContext".
 */
export function s2NodeDevPlugin(): Plugin {
  let runtime: SelfHostRuntime | undefined;

  return {
    name: "s2-node-dev",
    configureServer(viteDevServer) {
      return () => {
        if (viteDevServer.config.server.middlewareMode) return;

        viteDevServer.middlewares.use(async (nodeReq, nodeRes, next) => {
          if (nodeReq.method === undefined) return next();

          try {
            runtime ??= await loadRuntime(viteDevServer);
            const root = viteDevServer.config.root;
            const { createSelfHostLoadContext } =
              await viteDevServer.ssrLoadModule(
                path.join(root, "app/lib/selfhost/runtime.server.ts"),
              );
            const { handleDavRequest } = await viteDevServer.ssrLoadModule(
              path.join(root, "app/lib/gateway/dav.ts"),
            );
            const { evaluateEdge } = await viteDevServer.ssrLoadModule(
              path.join(root, "app/lib/gateway/middleware.ts"),
            );
            const fetchServer = await import("@remix-run/node-fetch-server");
            if (nodeReq.originalUrl) {
              nodeReq.url = nodeReq.originalUrl;
            }
            const request = await fetchServer.createRequest(nodeReq, nodeRes);
            const url = new URL(request.url);
            const context = createSelfHostLoadContext(runtime);

            if (url.pathname === "/dav" || url.pathname.startsWith("/dav/")) {
              const response = await handleDavRequest(request, context);
              await fetchServer.sendResponse(nodeRes, response);
              return;
            }

            const blocked = evaluateEdge(
              request,
              url.pathname,
              runtime.env.APP_URL ?? "",
            );
            if (blocked) {
              await fetchServer.sendResponse(nodeRes, blocked);
              return;
            }

            const build = (await viteDevServer.ssrLoadModule(
              SERVER_BUILD_ID,
            )) as ServerBuild;
            const handler = createRequestHandler(build, "development");
            const response = await handler(request, context);
            await fetchServer.sendResponse(nodeRes, response);
          } catch (error) {
            next(error);
          }
        });
      };
    },
  };
}
