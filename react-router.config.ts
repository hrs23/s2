import type { Config } from "@react-router/dev/config";

export default {
  future: {
    v8_viteEnvironmentApi: true,
  },
  // Disable React Router's built-in action CSRF check. It compares `Origin`
  // with `Host` / `X-Forwarded-Host` and rejects mismatches with 400, which
  // misfires when upstream proxies drift Origin from the request Host. Our own
  // defence (app/lib/auth/origin-check.server.ts) validates `Origin`
  // against the server-side APP_URL constant and is immune to header
  // pollution. The structural test
  // app/routes/__tests__/ui-route-csrf.test.ts enforces that every UI route
  // action continues to invoke `checkSameOrigin`.
  allowedActionOrigins: ["**"],
} satisfies Config;
