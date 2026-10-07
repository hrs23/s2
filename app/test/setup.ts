import "@testing-library/jest-dom/vitest";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterAll, afterEach, beforeAll } from "vitest";
import enAccessPaths from "~/i18n/locales/en/access-paths.json";
import enCommon from "~/i18n/locales/en/common.json";
import enFiles from "~/i18n/locales/en/files.json";
import enLogin from "~/i18n/locales/en/login.json";
import enSettings from "~/i18n/locales/en/settings.json";
import enTokens from "~/i18n/locales/en/tokens.json";
import { server } from "./msw-server";

i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: {
      "access-paths": enAccessPaths,
      common: enCommon,
      login: enLogin,
      files: enFiles,
      tokens: enTokens,
      settings: enSettings,
    },
  },
  defaultNS: "common",
  interpolation: { escapeValue: false },
});

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
