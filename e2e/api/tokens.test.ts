import { expect, test } from "@playwright/test";
import { deleteToken, issueToken, setAuthCookie } from "../helpers";

// HTTP smoke test; detailed behavior is covered by the integration tests.
test("token create, list and revoke round trip", async ({ page }) => {
  await setAuthCookie(page);
  const name = `e2e-tokens-test-${Date.now()}`;
  const issued = await issueToken(page, { name });
  expect(issued.raw_token).toMatch(/^s2_/);

  try {
    const listRes = await page.request.get("/internal/tokens");
    const { tokens } = await listRes.json();
    expect(tokens.map((t: { id: string }) => t.id)).toContain(issued.id);

    const res = await page.request.delete(`/api/v1/tokens/${issued.id}`);
    expect(res.status()).toBe(204);
  } catch (e) {
    await deleteToken(page, issued.id).catch(() => {});
    throw e;
  }
});
