// API type definitions (generated from openapi.yaml) + fetch wrapper.
//
// WebUI hits /api/v1/* (shared, cookie-authed via Better Auth
// session) for file ops + token create/revoke; /internal/* (cookie-only,
// OpenAPI-exempt) for account / token lifecycle / history /
// recovery / trash / settings. External clients use the same /api/v1/*
// surface with a Bearer token.

import type { components } from "./api.generated";

// Re-export generated types for public API
export type AccessPath = components["schemas"]["AccessPath"];
export type ApiToken = components["schemas"]["ApiToken"];
export type FileItem = components["schemas"]["FileItem"];
export type TokenIntrospection = components["schemas"]["TokenIntrospection"];

// Internal token list includes extra fields not in the public API.
// `has_active_secret` = the token row currently holds a usable secret; it
// drives the UI's "issue" (first time) vs "rotate" (replace) split.
export interface InternalApiToken extends ApiToken {
  has_active_secret: boolean;
  token_expires_at: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Extract a human-readable error message from a non-OK response. Handles
// both the canonical `{ error: { code, message } }` shape and the legacy
// `{ error: "message" }` shape; falls back to res.statusText when neither
// is present (or the body is not JSON).
async function parseApiErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string } | string;
  } | null;
  const error = body?.error;
  if (error == null) return fallback;
  if (typeof error === "string") return error;
  return error.message ?? fallback;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      await parseApiErrorMessage(res, res.statusText),
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  files: {
    list: (prefix = "") =>
      apiFetch<{ items: FileItem[] }>(`/api/v1/files/${prefix}`),
    upload: (path: string, body: ArrayBuffer) =>
      apiFetch<{
        id: string;
        name: string;
        size: number;
        hash: string;
        content_version: number;
      }>(`/api/v1/files/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      }),
    delete: (key: string) =>
      apiFetch<void>(`/api/v1/files/${key}`, { method: "DELETE" }),
    move: (from: string, to: string) =>
      apiFetch<{ id: string; content_version: number }>("/api/v1/files-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      }),
  },

  uploads: {
    create: (path: string, totalSize: number) =>
      apiFetch<{
        sessionId: string;
        nodeId: string;
        chunkSize: number;
        expiresAt: string;
      }>("/api/v1/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, totalSize }),
      }),
    uploadChunk: async (
      sessionId: string,
      chunkIndex: number,
      body: ArrayBuffer,
    ) => {
      const res = await fetch(`/api/v1/uploads/${sessionId}/${chunkIndex}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      });
      if (!res.ok) {
        throw new ApiError(
          res.status,
          await parseApiErrorMessage(res, res.statusText),
        );
      }
      return res.json() as Promise<{
        chunkIndex: number;
        size: number;
        checksum: string;
      }>;
    },
    complete: (sessionId: string) =>
      apiFetch<{
        nodeId: string;
        size: number;
        chunkCount: number;
        content_version: number;
      }>(`/api/v1/uploads/${sessionId}/complete`, { method: "POST" }),
    cancel: (sessionId: string) =>
      apiFetch<void>(`/api/v1/uploads/${sessionId}`, { method: "DELETE" }),
  },

  // /internal/* — cookie-only WebUI surface.
  internal: {
    // Recovery / version-history primitives. Cookie-only: the
    // AI-reachable /api/v1/* surface deliberately does not expose the
    // ability to roll back or undelete data.
    revisions: {
      list: (path: string) =>
        apiFetch<{
          revisions: {
            id: string;
            size: number;
            content_type: string;
            hash: string | null;
            created_at: string;
            is_current: boolean;
          }[];
        }>(`/internal/revisions?path=${encodeURIComponent(path)}`),
      restore: (path: string, revisionId: string) =>
        apiFetch<{ ok: true }>("/internal/files-restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, revision_id: revisionId }),
        }),
    },

    trash: {
      list: () =>
        apiFetch<{
          items: {
            id: string;
            name: string;
            type: "file" | "directory";
            size: number;
            deleted_at: string | null;
          }[];
        }>("/internal/trash"),
      restore: (id: string) =>
        apiFetch<{ ok: true }>(`/internal/trash/${id}/restore`, {
          method: "POST",
        }),
      purge: (id: string) =>
        apiFetch<void>(`/internal/trash/${id}`, { method: "DELETE" }),
      purgeAll: () => apiFetch<void>("/internal/trash", { method: "DELETE" }),
    },

    tokens: {
      list: () =>
        apiFetch<{
          tokens: InternalApiToken[];
          grant_count: number;
          grant_limit: number;
        }>("/internal/tokens"),
      // Token create lives at /api/v1/tokens (cookie creates user-root token,
      // Bearer with can_delegate creates child token — same endpoint).
      create: (
        name: string,
        base_path: string,
        canDelegate: boolean,
        access_paths: AccessPath[],
        expiresInDays?: number,
      ) =>
        apiFetch<{ token: ApiToken; raw_token: string; expires_at: string }>(
          "/api/v1/tokens",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              base_path,
              can_delegate: canDelegate,
              access_paths,
              ...(expiresInDays !== undefined
                ? { expires_in_days: expiresInDays }
                : {}),
            }),
          },
        ),
      update: (
        id: string,
        patch: { name?: string; base_path?: string; can_delegate?: boolean },
      ) =>
        apiFetch<{
          id: string;
          name: string;
          base_path: string;
          can_delegate: boolean;
        }>(`/internal/tokens/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      // Revoke lives at /api/v1/tokens/{id} (cookie can revoke own tokens,
      // Bearer can revoke its own children — same endpoint).
      delete: (id: string) =>
        apiFetch<void>(`/api/v1/tokens/${id}`, { method: "DELETE" }),
      issueToken: (id: string, expiresInDays?: number) =>
        apiFetch<{ token: string; expires_at: string }>(
          `/internal/tokens/${id}/issue`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              expiresInDays ? { expires_in_days: expiresInDays } : {},
            ),
          },
        ),
      rotateToken: (id: string, expiresInDays?: number) =>
        apiFetch<{ token: string; expires_at: string }>(
          `/internal/tokens/${id}/rotate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              expiresInDays ? { expires_in_days: expiresInDays } : {},
            ),
          },
        ),
      updateAccessPaths: (id: string, access_paths: AccessPath[]) =>
        apiFetch<{ access_paths: AccessPath[] }>(
          `/internal/tokens/${id}/access-paths`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access_paths }),
          },
        ),
    },
  },
};
