import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import packageJson from "./package.json";
import { s2NodeDevPlugin } from "./vite/node-dev-plugin";

/**
 * Vite's dev server intercepts OPTIONS requests for CORS preflight and never
 * forwards them to the SSR handler. For WebDAV /dav/* paths, OPTIONS
 * must reach the app so it can return the DAV compliance headers.
 */
function davOptionsPlugin(): Plugin {
  return {
    name: "dav-options",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          req.method === "OPTIONS" &&
          req.url &&
          (req.url === "/dav" || req.url.startsWith("/dav/"))
        ) {
          res.writeHead(204, {
            Allow:
              "OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK",
            DAV: "1,2,3",
            "MS-Author-Via": "DAV",
          });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  define: {
    __S2_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    davOptionsPlugin(),
    s2NodeDevPlugin(),
    reactRouter(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  server: {
    strictPort: true,
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(",")
      : undefined,
  },
});
