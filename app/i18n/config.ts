import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";

import enAccessPaths from "./locales/en/access-paths.json";
import enCommon from "./locales/en/common.json";
import enConnections from "./locales/en/connections.json";
import enDocs from "./locales/en/docs.json";
import enFiles from "./locales/en/files.json";
import enLogin from "./locales/en/login.json";
import enSettings from "./locales/en/settings.json";
import enTokens from "./locales/en/tokens.json";
import enTrash from "./locales/en/trash.json";

const resources = {
  en: {
    "access-paths": enAccessPaths,
    common: enCommon,
    connections: enConnections,
    docs: enDocs,
    login: enLogin,
    files: enFiles,
    tokens: enTokens,
    settings: enSettings,
    trash: enTrash,
  },
} as const;

/** Create an isolated English i18next instance for each render environment. */
export async function createI18nInstance(): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources,
    defaultNS: "common",
    interpolation: { escapeValue: false },
  });
  return instance;
}
