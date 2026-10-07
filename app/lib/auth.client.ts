// Browser-side Better Auth client.
//
// Used by routes that drive sign-in / sign-up / sign-out from the UI without
// a form POST round-trip. Server-side flows still go through `auth.api.*` via
// the cached factory in `app/lib/auth.server.ts`.
//
// `baseURL` is omitted: the client defaults to `window.location.origin`, which
// matches the server's APP_URL origin so the cookie domain stays aligned.

import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    // Passkey — wires `authClient.signIn.passkey()`,
    // `authClient.passkey.addPasskey()`, `authClient.passkey.listUserPasskeys()`,
    // etc. The browser side handles `navigator.credentials.create/get`
    // ceremonies; server verification lives in the matching server plugin.
    passkeyClient(),
    // Two-factor — wires `authClient.twoFactor.enable()` /
    // `authClient.twoFactor.verifyTotp()` / `.verifyBackupCode()` /
    // `.disable()` / `.generateBackupCodes()` / `.getTotpUri()`. The
    // `onTwoFactorRedirect` callback fires after a password sign-in if the
    // user has 2FA enabled — we route to /login/two-factor where the prompt
    // page consumes the short-lived `better-auth.two_factor` cookie.
    twoFactorClient({
      onTwoFactorRedirect: () => {
        if (typeof window === "undefined") return;
        // Preserve any returnTo so the post-verify redirect lands where the
        // user originally intended.
        const search = window.location.search;
        window.location.assign(`/login/two-factor${search}`);
      },
    }),
  ],
});
