// @vitest-environment node
// Integration tests for POST /mcp (Streamable HTTP)
// 401 + WWW-Authenticate / audience binding / tool execution

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "~/lib/auth/token.server";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  sessionCookieHeader,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action, loader } from "../mcp";

let testEnv: TestEnv;
const USER_ID = "user_mcp_test";
const MCP_RESOURCE = "http://localhost/mcp";

function ctx() {
  return testLoadContext(testEnv);
}

async function seedOAuthGrantWithAccessToken(opts: {
  token: string;
  resource: string | null;
  paths?: Array<{ path: string; access: "read" | "write" }>;
}): Promise<void> {
  const grantId = `grt_mcp_${Date.now()}`;
  const clientId = `dcr_test_${Date.now()}`;
  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Test', ARRAY['http://127.0.0.1/cb'], 'none')`,
    [clientId],
  );
  await testEnv.db.execute(
    `INSERT INTO grants (id, user_id, base_path, created_at)
     VALUES ($1, $2, '/', now())`,
    [grantId, USER_ID],
  );
  await testEnv.db.execute(
    `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes, resource)
     VALUES ($1, $2, $3, ARRAY['files'], $4)`,
    [grantId, USER_ID, clientId, opts.resource],
  );
  for (const p of opts.paths ?? [{ path: "", access: "write" }]) {
    await testEnv.db.execute(
      `INSERT INTO grant_paths (grant_id, path, access) VALUES ($1, $2, $3)`,
      [grantId, p.path, p.access],
    );
  }
  const hash = await hashToken(opts.token);
  await testEnv.db.execute(
    `INSERT INTO access_tokens (grant_id, user_id, token_hash, expires_at)
     SELECT id, user_id, $2, now() + INTERVAL '1 hour'
     FROM grants WHERE id = $1`,
    [grantId, hash],
  );
}

async function mcpRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_ID });
});

describe("/mcp authentication", () => {
  it("returns 401 + WWW-Authenticate when no Authorization header", async () => {
    const res = await action({
      request: await mcpRequest({ jsonrpc: "2.0", method: "ping", id: 1 }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toMatch(/Bearer/);
    expect(wwwAuth).toMatch(/resource_metadata=/);
    expect(wwwAuth).toMatch(/scope="files"/);
  });

  it("rejects browser cookie session with 401 + WWW-Authenticate (MCP is bearer-only)", async () => {
    // getTokenAuthContext refuses cookie-only auth so a leaked
    // web session cannot impersonate an MCP client. Same 401 + RFC 9728
    // challenge as the no-credential case, so DCR-aware clients can recover.
    const cookie = await sessionCookieHeader(USER_ID, testEnv.env);
    const res = await action({
      request: await mcpRequest(
        { jsonrpc: "2.0", method: "ping", id: 1 },
        { Cookie: cookie },
      ),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/Bearer/);
  });

  it("rejects token without audience binding (resource = null)", async () => {
    const token = "s2_mcp_test_no_aud";
    await seedOAuthGrantWithAccessToken({ token, resource: null });
    const res = await action({
      request: await mcpRequest(
        { jsonrpc: "2.0", method: "ping", id: 1 },
        { Authorization: `Bearer ${token}` },
      ),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(401);
  });

  it("rejects token bound to different resource", async () => {
    const token = "s2_mcp_test_diff_aud";
    await seedOAuthGrantWithAccessToken({
      token,
      resource: "https://other.example/mcp",
    });
    const res = await action({
      request: await mcpRequest(
        { jsonrpc: "2.0", method: "ping", id: 1 },
        { Authorization: `Bearer ${token}` },
      ),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(401);
  });

  it("accepts token with matching audience", async () => {
    const token = "s2_mcp_test_ok";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });
    const res = await action({
      request: await mcpRequest(
        {
          jsonrpc: "2.0",
          method: "initialize",
          id: 1,
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        },
        { Authorization: `Bearer ${token}` },
      ),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    const result = body.result as Record<string, unknown>;
    expect((result.serverInfo as Record<string, unknown>).name).toBe("s2");
  });

  it("returns 405 on GET (stateless: SSE upgrade not supported)", async () => {
    const res = await loader({
      request: new Request("http://localhost/mcp", { method: "GET" }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = Math.floor(Math.random() * 100000),
): Promise<{
  status: number;
  body: {
    result?: {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
    error?: unknown;
  };
}> {
  const res = await action({
    request: await mcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id,
        params: { name, arguments: args },
      },
      { Authorization: `Bearer ${token}` },
    ),
    context: ctx(),
    params: {},
    // biome-ignore lint/suspicious/noExplicitAny: test
  } as any);
  return { status: res.status, body: await res.json() };
}

describe("/mcp tools/list", () => {
  it("lists the 9 file tools with metadata", async () => {
    const token = "s2_mcp_test_tools";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });

    const res = await action({
      request: await mcpRequest(
        { jsonrpc: "2.0", method: "tools/list", id: 2 },
        { Authorization: `Bearer ${token}` },
      ),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const result = body.result as {
      tools: Array<{
        name: string;
        title?: string;
        description?: string;
        annotations?: Record<string, boolean>;
        outputSchema?: unknown;
      }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "files_delete",
      "files_list",
      "files_mkdir",
      "files_move",
      "files_read_binary",
      "files_read_text",
      "files_stat",
      "files_write",
      "files_write_binary",
    ]);

    // Every tool has a title, descriptive description, annotations, outputSchema
    for (const t of result.tools) {
      expect(t.title, `${t.name} title`).toBeTruthy();
      expect(
        t.description?.length ?? 0,
        `${t.name} description`,
      ).toBeGreaterThan(40);
      expect(t.annotations, `${t.name} annotations`).toBeTruthy();
      expect(t.outputSchema, `${t.name} outputSchema`).toBeTruthy();
    }

    const writeTool = result.tools.find((t) => t.name === "files_write");
    expect(writeTool?.annotations?.destructiveHint).toBe(true);
    const listTool = result.tools.find((t) => t.name === "files_list");
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("/mcp text round-trip (files_write / files_read_text)", () => {
  it("preserves multibyte UTF-8 (Japanese, emoji) without base64", async () => {
    const token = "s2_mcp_test_text";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });

    const content = "こんにちは 🎉\nsecond line";
    const path = "/hello.md";
    const w = await callTool(token, "files_write", { path, content });
    expect(w.body.result?.isError).toBeFalsy();
    expect((w.body.result?.structuredContent as { path: string }).path).toBe(
      path,
    );

    const r = await callTool(token, "files_read_text", { path });
    expect(r.body.result?.isError).toBeFalsy();
    const sc = r.body.result?.structuredContent as {
      content: string;
      content_type: string;
    };
    expect(sc.content).toBe(content);
    expect(sc.content_type).toMatch(/text\/markdown/);
  });

  it("guesses MIME from extension when mime_type is omitted", async () => {
    const token = "s2_mcp_test_mime";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });

    await callTool(token, "files_write", {
      path: "/data.json",
      content: '{"a":1}',
    });
    const r = await callTool(token, "files_stat", { path: "/data.json" });
    const sc = r.body.result?.structuredContent as { content_type: string };
    expect(sc.content_type).toMatch(/application\/json/);
  });

  it("respects explicit mime_type", async () => {
    const token = "s2_mcp_test_mime2";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });

    await callTool(token, "files_write", {
      path: "/note.txt",
      content: "hello",
      mime_type: "text/x-custom; charset=utf-8",
    });
    const r = await callTool(token, "files_stat", { path: "/note.txt" });
    const sc = r.body.result?.structuredContent as { content_type: string };
    expect(sc.content_type).toBe("text/x-custom; charset=utf-8");
  });
});

describe("/mcp binary round-trip (files_write_binary / files_read_binary)", () => {
  it("preserves binary bytes through base64", async () => {
    const token = "s2_mcp_test_bin";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });

    // PNG signature + arbitrary bytes (invalid UTF-8 sequence: 0xff 0xfe)
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
    ]);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);

    const w = await callTool(token, "files_write_binary", {
      path: "/blob.png",
      content_base64: b64,
      mime_type: "image/png",
    });
    expect(w.body.result?.isError).toBeFalsy();

    const r = await callTool(token, "files_read_binary", { path: "/blob.png" });
    const sc = r.body.result?.structuredContent as {
      content_base64: string;
      mime_type: string;
    };
    expect(sc.content_base64).toBe(b64);
    expect(sc.mime_type).toBe("image/png");
  });

  it("files_read_text returns invalid_utf8 for binary content", async () => {
    const token = "s2_mcp_test_invalid_utf8";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });
    const b64 = btoa("\xff\xfe\x00\x01"); // not valid UTF-8
    await callTool(token, "files_write_binary", {
      path: "/blob.bin",
      content_base64: b64,
      mime_type: "application/octet-stream",
    });
    const r = await callTool(token, "files_read_text", { path: "/blob.bin" });
    expect(r.body.result?.isError).toBe(true);
    expect((r.body.result?.structuredContent as { code: string }).code).toBe(
      "invalid_utf8",
    );
  });

  it("rejects malformed base64 with invalid_base64", async () => {
    const token = "s2_mcp_test_bad_b64";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });
    const r = await callTool(token, "files_write_binary", {
      path: "/x.bin",
      content_base64: "!!!not-base64!!!",
      mime_type: "application/octet-stream",
    });
    expect(r.body.result?.isError).toBe(true);
    expect((r.body.result?.structuredContent as { code: string }).code).toBe(
      "invalid_base64",
    );
  });
});

describe("/mcp error contract", () => {
  it("returns structured isError for missing path", async () => {
    const token = "s2_mcp_test_err_404";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });
    const r = await callTool(token, "files_read_text", { path: "/no.md" });
    expect(r.body.result?.isError).toBe(true);
    expect((r.body.result?.structuredContent as { code: string }).code).toBe(
      "not_found",
    );
  });

  it("returns is_directory when reading a directory", async () => {
    const token = "s2_mcp_test_isdir";
    await seedOAuthGrantWithAccessToken({ token, resource: MCP_RESOURCE });
    await callTool(token, "files_mkdir", { path: "/a-dir" });
    const r = await callTool(token, "files_read_text", { path: "/a-dir" });
    expect(r.body.result?.isError).toBe(true);
    expect((r.body.result?.structuredContent as { code: string }).code).toBe(
      "is_directory",
    );
  });
});
