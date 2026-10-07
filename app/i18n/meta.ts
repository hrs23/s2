import enDocs from "./locales/en/docs.json";
import enLogin from "./locales/en/login.json";

const titles = {
  docs: enDocs.meta.title,
  "docs.index": enDocs.meta.gettingStartedTitle,
  "docs.webdav": enDocs.webdav.meta.title,
  "docs.rest": enDocs.rest.meta.title,
  "docs.mcp": enDocs.mcp.meta.title,
  login: enLogin.meta.title,
  signup: enLogin.meta.signupTitle,
  twoFactor: enLogin.meta.twoFactorTitle,
  forgotPassword: enLogin.meta.forgotPasswordTitle,
  resetPassword: enLogin.meta.resetPasswordTitle,
};

export function pageTitle(page: keyof typeof titles): string {
  return titles[page] ?? "";
}
