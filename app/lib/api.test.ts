import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "~/test/msw-server";
import { ApiError, api } from "./api";

// The global setup.ts already manages server lifecycle.
// Use server.use() to override handlers per test.

describe("apiFetch error handling", () => {
  it("throws ApiError with structured error message", async () => {
    server.use(
      http.get("/api/v1/files/docs/", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Invalid token" } },
          { status: 401 },
        ),
      ),
    );

    try {
      await api.files.list("docs/");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(401);
      expect((e as ApiError).message).toBe("Invalid token");
    }
  });

  it("throws ApiError with legacy string error", async () => {
    server.use(
      http.get("/api/v1/files/docs/", () =>
        HttpResponse.json({ error: "Legacy error" }, { status: 400 }),
      ),
    );

    try {
      await api.files.list("docs/");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Legacy error");
    }
  });

  it("returns undefined for 204 responses", async () => {
    server.use(
      http.delete(
        "/api/v1/files/test.txt",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const result = await api.files.delete("test.txt");
    expect(result).toBeUndefined();
  });
});

describe("api.files", () => {
  it("list sends GET and parses items", async () => {
    server.use(
      http.get("/api/v1/files/docs/", () =>
        HttpResponse.json({
          items: [{ name: "file.txt", type: "file", size: 10 }],
        }),
      ),
    );

    const result = await api.files.list("docs/");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("file.txt");
  });

  it("upload sends PUT with octet-stream content type", async () => {
    server.use(
      http.put("/api/v1/files/test.txt", async ({ request }) => {
        expect(request.headers.get("Content-Type")).toBe(
          "application/octet-stream",
        );
        return HttpResponse.json({
          name: "test.txt",
          size: 5,
          hash: "abc",
          content_version: 1,
        });
      }),
    );

    const body = new TextEncoder().encode("hello").buffer;
    const result = await api.files.upload("test.txt", body);
    expect(result.name).toBe("test.txt");
  });
});

describe("api.internal.tokens", () => {
  it("issueToken sends POST with expires_in_days", async () => {
    server.use(
      http.post("/internal/tokens/tok_1/issue", async ({ request }) => {
        const body = (await request.json()) as { expires_in_days?: number };
        expect(body.expires_in_days).toBe(30);
        return HttpResponse.json(
          { token: "s2_issued", expires_at: "2026-01-01" },
          { status: 201 },
        );
      }),
    );

    const result = await api.internal.tokens.issueToken("tok_1", 30);
    expect(result.token).toBe("s2_issued");
  });

  it("updateAccessPaths sends PUT with access_paths array", async () => {
    server.use(
      http.put("/internal/tokens/tok_1/access-paths", async ({ request }) => {
        const body = (await request.json()) as {
          access_paths: unknown[];
        };
        expect(body.access_paths).toHaveLength(1);
        return HttpResponse.json({
          access_paths: [{ path: "docs", access: "read" }],
        });
      }),
    );

    const result = await api.internal.tokens.updateAccessPaths("tok_1", [
      { path: "docs", access: "read" },
    ]);
    expect(result.access_paths).toHaveLength(1);
  });
});
