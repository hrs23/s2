import type { AppLoadContext } from "react-router";
import type { AppContext } from "~/lib/app-context.server";

declare module "react-router" {
  interface AppLoadContext {
    readonly appContext?: AppContext;
    readonly runtime?: { readonly env: Env };
  }
}

export function getAppContext(context: AppLoadContext): AppContext {
  if (!context.appContext) {
    throw new Error("AppContext missing from AppLoadContext");
  }
  return context.appContext;
}

export function getRuntimeEnv(context: AppLoadContext): Env {
  const env = context.runtime?.env;
  if (!env) {
    throw new Error("Runtime env missing from AppLoadContext");
  }
  return env;
}
