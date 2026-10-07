// GET/POST /oauth/authorize — OAuth 2.1 Authorization endpoint + consent UI
//
// GET: validate request → redirect to /login if anon → render consent UI
// POST: take user's consent → issue authorization code → redirect to redirect_uri
//
// The consent UI shows `client_name`, `redirect_uri` and the requested scope
// plainly. There is no verified badge or "official" label; trust is
// established out-of-band (download source + code signing).

import { useState } from "react";
import {
  type ActionFunctionArgs,
  Form,
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { AtLimitView } from "~/components/access-grants/AtLimitView";
import {
  type AccessPath,
  AccessPathEditor,
  AccessPathsValidationError,
  accessPathsForSubmit,
  PathInputWithBrowse,
  trimAccessPathRows,
} from "~/components/access-paths";
import { validateAccessPaths } from "~/lib/access-paths/validate";
import type { InternalApiToken } from "~/lib/api";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getAuthContext } from "~/lib/auth/auth.server";
import { checkSameOrigin } from "~/lib/auth/origin-check.server";
import { validateBasePath } from "~/lib/files/paths";
import type { ValidatedAuthorizeRequest } from "~/lib/oauth/oauth-service.server";
import type { OAuthError } from "~/lib/oauth/types";
import { createServices } from "~/lib/service-factory.server";
import type { OAuthGrantSummary } from "./internal.oauth-grants";

interface LoaderData {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  code_challenge: string;
  resource: string | null;
}

interface AtLimitData {
  at_limit: true;
  client_name: string;
  count: number;
  limit: number;
  tokens: InternalApiToken[];
  grants: OAuthGrantSummary[];
}

type LoaderResult = LoaderData | AtLimitData | OAuthError;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getRuntimeEnv(context);
  const url = new URL(request.url);
  const params = url.searchParams;

  const auth = await getAuthContext(request, env);
  if (!auth || auth.type !== "user") {
    const returnTo = `${url.pathname}${url.search}`;
    return redirect(`/login?${new URLSearchParams({ returnTo })}`);
  }

  const { oauthService, tokenService } = createServices(
    getAppContext(context),
    auth.user_id,
  );

  const result = await oauthService.validateAuthorizeRequest({
    responseType: params.get("response_type") ?? "",
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    scope: params.get("scope") ?? "",
    state: params.get("state") ?? undefined,
    codeChallenge: params.get("code_challenge") ?? "",
    codeChallengeMethod: params.get("code_challenge_method") ?? "",
    resource: params.get("resource") ?? undefined,
  });

  if (!result.ok) {
    // Pre-validation: only show in-page (we can't trust redirect_uri yet).
    return Response.json(result.error, { status: 400 });
  }

  const v = result.value;
  const limitCheck = await oauthService.checkGrantLimit(
    auth.user_id,
    v.client.id,
  );
  if (limitCheck.exceeded) {
    const [tokenList, grantList] = await Promise.all([
      tokenService.list(auth.user_id),
      oauthService.listGrantsForUser(auth.user_id),
    ]);
    const data: AtLimitData = {
      at_limit: true,
      client_name: v.client.client_name,
      count: limitCheck.count,
      limit: limitCheck.limit,
      tokens: tokenList.tokens,
      grants: grantList,
    };
    return Response.json(data);
  }

  const data: LoaderData = {
    client_id: v.client.id,
    client_name: v.client.client_name,
    redirect_uri: v.redirectUri,
    scopes: v.scopes,
    state: v.state ?? null,
    code_challenge: v.codeChallenge,
    resource: v.resource,
  };
  return Response.json(data);
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = getRuntimeEnv(context);
  if (!checkSameOrigin(request, env.APP_URL).ok) {
    return new Response("Forbidden", { status: 403 });
  }
  const auth = await getAuthContext(request, env);
  if (!auth || auth.type !== "user") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const decision = form.get("decision")?.toString();

  const validateParams = {
    responseType: form.get("response_type")?.toString() ?? "",
    clientId: form.get("client_id")?.toString() ?? "",
    redirectUri: form.get("redirect_uri")?.toString() ?? "",
    scope: form.get("scope")?.toString() ?? "",
    state: form.get("state")?.toString() || undefined,
    codeChallenge: form.get("code_challenge")?.toString() ?? "",
    codeChallengeMethod: form.get("code_challenge_method")?.toString() ?? "",
    resource: form.get("resource")?.toString() || undefined,
  };

  const { oauthService } = createServices(getAppContext(context), auth.user_id);
  const validated = await oauthService.validateAuthorizeRequest(validateParams);
  if (!validated.ok) {
    return Response.json(validated.error, { status: 400 });
  }
  const request_ = validated.value as ValidatedAuthorizeRequest;

  if (decision === "deny") {
    const url = new URL(request_.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (request_.state) url.searchParams.set("state", request_.state);
    return redirect(url.toString());
  }

  const basePath = (form.get("base_path")?.toString() || "/").trim();
  const basePathErr = validateBasePath(basePath);
  if (basePathErr) {
    return Response.json(
      { error: "invalid_request", error_description: basePathErr },
      { status: 400 },
    );
  }
  // read/write lives on the grant, not the OAuth scope.
  // Defense-in-depth: the consent form canonicalizes empties via
  // accessPathsForSubmit before submit, so reaching here with
  // [] means a direct POST that bypassed the UI — reject.
  const pathStrings = form.getAll("path").map((p) => p.toString());
  const accessStrings = form.getAll("access").map((a) => a.toString());
  const paths: AccessPath[] = trimAccessPathRows(
    pathStrings.map((path, i) => ({
      path,
      access: accessStrings[i] === "write" ? "write" : "read",
    })),
  );
  if (paths.length === 0) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "at least one path required",
      },
      { status: 400 },
    );
  }

  const issued = await oauthService.issueAuthorizationCode(
    request_,
    auth.user_id,
    { basePath, paths },
  );
  if (!issued.ok) {
    return Response.json(issued.error, { status: 400 });
  }

  const redirectUrl = new URL(request_.redirectUri);
  redirectUrl.searchParams.set("code", issued.value.code);
  if (request_.state) redirectUrl.searchParams.set("state", request_.state);
  return redirect(redirectUrl.toString());
}

// ---------------------------------------------------------------------------
// UI: plain wording, no verified badge.
// ---------------------------------------------------------------------------

export default function OAuthAuthorize() {
  const data = useLoaderData<typeof loader>() as LoaderResult;
  const { revalidate } = useRevalidator();
  const [basePath, setBasePath] = useState("/");
  // empty = "all under base_path". The submit handler
  // canonicalizes via accessPathsForSubmit; here we just let users start
  // with the "All paths accessible" hint and opt into narrowing.
  const [accessPaths, setAccessPaths] = useState<AccessPath[]>([]);

  if ("error" in data) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-2xl font-bold mb-2">
          Authorization request invalid
        </h1>
        <p className="mb-2 text-sm text-gray-700">
          The OAuth request could not be processed.
        </p>
        <pre className="rounded border border-gray-200 bg-gray-50 p-3 text-xs font-mono">
          {data.error}
        </pre>
        {data.error_description && (
          <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap break-words">
            {data.error_description}
          </p>
        )}
      </div>
    );
  }

  if ("at_limit" in data) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <AtLimitView
          tokens={data.tokens}
          grants={data.grants}
          count={data.count}
          limit={data.limit}
          heading={`Connect ${data.client_name}`}
          description={`You're using ${data.count} of ${data.limit} access grants. Revoke an existing one to authorize ${data.client_name}.`}
          onRevoked={async () => {
            await revalidate();
          }}
        />
      </div>
    );
  }

  const pathsErr = validateAccessPaths(accessPaths);
  const submitDisabled = pathsErr !== null;

  return (
    <div className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-bold mb-2">Authorize {data.client_name}</h1>

      <p className="mb-2 text-sm">
        <strong>{data.client_name}</strong> is requesting access to:
      </p>
      <ul className="ml-4 mb-4 list-disc text-sm">
        {data.scopes.map((s) => (
          <li key={s}>{scopeLabel(s)}</li>
        ))}
      </ul>

      <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
        <p className="text-xs uppercase tracking-wide text-gray-500">
          Connection details
        </p>
        <p>
          <span className="text-gray-500">App name: </span>
          <span className="font-medium break-words">{data.client_name}</span>
        </p>
        <p>
          <span className="text-gray-500">Redirect URL: </span>
          <code className="break-all rounded bg-white px-1 py-0.5 text-xs">
            {data.redirect_uri}
          </code>
        </p>
        <p className="text-xs text-gray-500">
          Only continue if you started this connection. S2 does not review apps;
          check the redirect URL above looks right before allowing.
        </p>
      </div>

      <Form method="post" className="space-y-4">
        {/* Echo back the original request params */}
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value={data.client_id} />
        <input type="hidden" name="redirect_uri" value={data.redirect_uri} />
        <input type="hidden" name="scope" value={data.scopes.join(" ")} />
        {data.state !== null && (
          <input type="hidden" name="state" value={data.state} />
        )}
        <input
          type="hidden"
          name="code_challenge"
          value={data.code_challenge}
        />
        <input type="hidden" name="code_challenge_method" value="S256" />
        {data.resource !== null && (
          <input type="hidden" name="resource" value={data.resource} />
        )}

        {/* Mirror React state into form fields on submit. an
            empty editor canonicalizes to a single "all under base_path" row
            before reaching the server. */}
        <input type="hidden" name="base_path" value={basePath} />
        {accessPathsForSubmit(accessPaths).map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are ordered, index stable per submit
          <span key={i}>
            <input type="hidden" name="path" value={p.path} />
            <input type="hidden" name="access" value={p.access} />
          </span>
        ))}

        <fieldset className="rounded border p-3 space-y-3">
          <legend className="px-2 text-sm font-medium">Folder access</legend>

          <div>
            <p className="block text-sm font-medium text-gray-700 mb-1">
              Base path
            </p>
            <PathInputWithBrowse value={basePath} onChange={setBasePath} />
          </div>

          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Paths</p>
            <AccessPathEditor
              accessPaths={accessPaths}
              onChange={setAccessPaths}
              basePath={basePath}
            />
            <AccessPathsValidationError error={pathsErr} />
          </div>
        </fieldset>

        <div className="flex gap-2">
          <button
            type="submit"
            name="decision"
            value="allow"
            disabled={submitDisabled}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            Allow
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded border px-4 py-2"
          >
            Cancel
          </button>
        </div>
      </Form>
    </div>
  );
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "files":
      return "Read or write your files";
    default:
      return scope;
  }
}
