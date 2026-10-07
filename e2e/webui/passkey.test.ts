// Passkey E2E.
//
// Drives the full WebAuthn ceremony end-to-end using Chromium's CDP virtual
// authenticator (`WebAuthn.addVirtualAuthenticator`). We programmatically
// register a passkey from /settings, then verify it appears in the
// list and that authClient.signIn.passkey() works against the same authenticator.
//
// Why a virtual authenticator: real passkeys require Touch ID / Windows Hello
// hardware which CI cannot drive. Chromium ships an in-process WebAuthn
// emulator for exactly this case (Playwright + Puppeteer use it the same way).

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { setAuthCookie } from "../helpers";

async function attachVirtualAuthenticator(page: Page): Promise<{
  client: CDPSession;
  authenticatorId: string;
}> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        // ctap2 + internal transport mimics a platform authenticator (Touch ID /
        // Windows Hello) which is what users see on real devices.
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { client, authenticatorId };
}

// Cold-start in the e2e container can blow past the default 30s — the first
// test pays the dev server / better-auth bootstrap and a vite client transform.
test.setTimeout(60_000);

test("user can register a passkey from /settings and see it in the list", async ({
  page,
}) => {
  // Attach the virtual authenticator AFTER reaching /settings (the Passkeys
  // section is inlined alongside Account / Security / Danger zone) —
  // CDP `WebAuthn.enable` is bound to the current target session and can
  // become stale across the post-login navigation, which surfaces as a
  // hanging click() in the registration flow.
  await page.goto("/login");
  await setAuthCookie(page);
  await page.goto("/settings");

  const { client, authenticatorId } = await attachVirtualAuthenticator(page);

  // Wait for PasskeysSection's mount-time `listUserPasskeys()` to settle.
  // Without this, the subsequent re-render (which adds the empty-state
  // paragraph) shifts the "Add a passkey" button mid-click and Playwright
  // aborts with "not stable" / "not visible".
  await page.waitForLoadState("networkidle");

  await page
    .getByRole("button", { name: /Add a passkey/ })
    .click();

  // The virtual authenticator answers navigator.credentials.create() and
  // Better Auth posts to /api/auth/passkey/verify-registration. After the
  // round-trip, listUserPasskeys() refreshes and a row with rename/delete
  // controls appears. We assert on the "Rename" button because it only
  // renders on registered passkey rows — matching the section heading or
  // description text would silently pass even when registration fails.
  await expect(
    page.getByRole("button", { name: /Rename/ }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Confirm at least one credential is registered on the virtual authenticator.
  const { credentials } = await client.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials.length).toBeGreaterThan(0);

  await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});

test("registered passkey can drive sign-in via the /login button", async ({
  page,
}) => {
  // First register a passkey (same flow as test above).
  await page.goto("/login");
  await setAuthCookie(page);
  await page.goto("/settings");
  const { client, authenticatorId } = await attachVirtualAuthenticator(page);
  // Match the first test: wait for PasskeysSection's mount-time
  // listUserPasskeys() to settle before clicking.
  await page.waitForLoadState("networkidle");
  // Snapshot the existing Rename row count. Earlier tests in this run can
  // leave passkeys for the same seeded user; without a delta we can't tell
  // whether the click actually completed the registration round-trip
  // before we rip up the session and try to sign in with the new credential.
  const renameButtons = page.getByRole("button", {
    name: /Rename/,
  });
  const initialCount = await renameButtons.count();
  await page
    .getByRole("button", { name: /Add a passkey/ })
    .click();
  // Wait for the registration to finish persisting (one new row appears).
  await expect(renameButtons).toHaveCount(initialCount + 1, {
    timeout: 10_000,
  });
  // And confirm the credential actually landed on this authenticator.
  const { credentials } = await client.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials.length).toBeGreaterThan(0);

  // Drop the password session so /login is reachable without an existing
  // cookie. The virtual authenticator and its credentials persist on the
  // CDP session, so the passkey survives the cookie wipe.
  await page.context().clearCookies();
  await page.goto("/login");

  const passkeyButton = page.getByRole("button", {
    name: /Sign in with a passkey/,
  });
  await expect(passkeyButton).toBeVisible();
  await passkeyButton.click();

  // Successful signIn.passkey() reloads to the dashboard / files.
  await expect(page).toHaveURL(/\/(files|$)/, { timeout: 15_000 });

  await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
