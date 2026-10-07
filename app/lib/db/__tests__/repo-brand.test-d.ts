// Compile-time contract: per-repository read/write distinction. Each writer
// method must demand `WithinUserWriteTx` (advisory lock acquired); methods
// that take no tx (non-RLS / stage-1 unscoped lookups) are also pinned.
//
// The brand-level relationship — DbClient cannot satisfy WithinUserTx,
// WithinUserWriteTx subtypes WithinUserTx — is asserted once in
// `within-user-tx.test-d.ts` and not duplicated per method.
//
// Type-only — no runtime code. Run by the `types` vitest project.

import type { TokenRepository } from "~/lib/auth/token-repository.server";
import type { UserRepository } from "~/lib/auth/user-repository.server";
import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import type { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import type { TrashRepository } from "~/lib/files/trash-repository.server";
import type { VersionRepository } from "~/lib/files/version-repository.server";
import type { OAuthGrantRepository } from "~/lib/oauth/oauth-grant-repository.server";
import type { RefreshTokenRepository } from "~/lib/oauth/refresh-token-repository.server";

declare const userTx: WithinUserTx;
declare const writeTx: WithinUserWriteTx;

// ── FileNodeRepository ────────────────────────────────────────────────
declare const fileNodes: FileNodeRepository;

fileNodes.createNode(
  {
    userId: "u_1",
    parentId: "",
    name: "a.txt",
    isDirectory: false,
    contentType: "text/plain",
    size: null,
  },
  writeTx,
);
fileNodes.createNode(
  {
    userId: "u_1",
    parentId: "",
    name: "a.txt",
    isDirectory: false,
    contentType: "text/plain",
    size: null,
  },
  // @ts-expect-error — createNode is a writer (advisory lock required)
  userTx,
);

fileNodes.moveNode("u_1", "n_1", "", "new.txt", writeTx);
// @ts-expect-error — moveNode is a writer
fileNodes.moveNode("u_1", "n_1", "", "new.txt", userTx);

// ── TrashRepository ──────────────────────────────────────────────────
declare const trash: TrashRepository;
trash.softDeleteNode("u_1", "n_1", writeTx);
// @ts-expect-error — softDeleteNode is a writer
trash.softDeleteNode("u_1", "n_1", userTx);

// ── VersionRepository ────────────────────────────────────────────────
declare const versions: VersionRepository;
versions.pruneNodeRevisions("n_1", 5, writeTx);
// @ts-expect-error — pruneNodeRevisions is a writer
versions.pruneNodeRevisions("n_1", 5, userTx);

// ── OAuthGrantRepository ─────────────────────────────────────────────
declare const oauthGrants: OAuthGrantRepository;
oauthGrants.create(
  {
    grantId: "g_1",
    userId: "u_1",
    basePath: "/",
    createdAt: "",
    oauthClientId: "c_1",
    oauthRequestedScopes: [],
    resource: null,
  },
  writeTx,
);

oauthGrants.create(
  {
    grantId: "g_1",
    userId: "u_1",
    basePath: "/",
    createdAt: "",
    oauthClientId: "c_1",
    oauthRequestedScopes: [],
    resource: null,
  },
  // @ts-expect-error — create is a writer
  userTx,
);

// ── TokenRepository ──────────────────────────────────────────────────
declare const tokens: TokenRepository;
// findByHash is a stage-1 unscoped lookup — takes no tx
tokens.findByHash("hash");

// ── UserRepository ───────────────────────────────────────────────────
declare const users: UserRepository;
users.addBytesUsed(100, "u_1", writeTx);
// @ts-expect-error — addBytesUsed is a writer
users.addBytesUsed(100, "u_1", userTx);

// ── RefreshTokenRepository ───────────────────────────────────────────
declare const refresh: RefreshTokenRepository;

// findByHash unscoped (stage-1)
refresh.findByHash("hash");

refresh.insert(
  { id: "rt_1", grantId: "g_1", tokenHash: "h", expiresAt: "" },
  writeTx,
);
refresh.insert(
  { id: "rt_1", grantId: "g_1", tokenHash: "h", expiresAt: "" },
  // @ts-expect-error — insert is a writer
  userTx,
);
