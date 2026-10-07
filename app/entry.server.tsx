import { renderToReadableStream } from "react-dom/server.edge";
import { I18nextProvider } from "react-i18next";
import type { EntryContext } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { createI18nInstance } from "~/i18n/config";
import { logError } from "~/lib/observability/logger.server";

export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  // 4xx thrown Responses are expected control flow (auth, 404, etc).
  if (isRouteErrorResponse(error) && error.status < 500) return;
  const pathname = new URL(request.url).pathname;
  logError("server", "loader_action_failed", { pathname }, error);
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const i18n = await createI18nInstance();

  const body = await renderToReadableStream(
    <I18nextProvider i18n={i18n}>
      <ServerRouter context={routerContext} url={request.url} />
    </I18nextProvider>,
    {
      signal: request.signal,
      onError(error: unknown) {
        // Log pathname only; query string can contain user input / PII.
        const pathname = new URL(request.url).pathname;
        logError("ssr", "render_failed", { pathname }, error);
        responseStatusCode = 500;
      },
    },
  );

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
