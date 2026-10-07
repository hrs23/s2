// Unified service factory — creates all services and repositories for a request.
// Consolidates file-service.factory.server.ts and upload-service.factory.server.ts.

import type { AppContext } from "~/lib/app-context.server";
import { AuthorizationService } from "~/lib/auth/authorization-service.server";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { TokenService } from "~/lib/auth/token-service.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { FileService } from "~/lib/files/file-service.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import { UploadService } from "~/lib/files/upload-service.server";
import { UploadSessionRepository } from "~/lib/files/upload-session-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { AuthorizationCodeRepository } from "~/lib/oauth/authorization-code-repository.server";
import { OAuthClientRepository } from "~/lib/oauth/oauth-client-repository.server";
import { OAuthGrantRepository } from "~/lib/oauth/oauth-grant-repository.server";
import {
  OAuthService,
  parseAllowedResources,
} from "~/lib/oauth/oauth-service.server";
import { RefreshTokenRepository } from "~/lib/oauth/refresh-token-repository.server";
import { ChunkedStorage } from "~/lib/storage/chunked.server";

export interface ServiceContainer {
  db: DbClient;
  fileService: FileService;
  uploadService: UploadService;
  tokenService: TokenService;
  oauthService: OAuthService;
  userRepo: UserRepository;
}

export function createServices(
  appContext: AppContext,
  userId: string,
): ServiceContainer {
  const db = appContext.db;
  const rawStorage = appContext.storage;
  const chunkedStorage = new ChunkedStorage(rawStorage, userId);

  const fileNodeRepo = new FileNodeRepository();
  const trashRepo = new TrashRepository();
  const versionRepo = new VersionRepository();
  const userRepo = new UserRepository(db);
  const tokenRepo = new TokenRepository(db);
  const sessionRepo = new UploadSessionRepository();

  const authz = new AuthorizationService();
  const quota = new QuotaService(userRepo, tokenRepo);

  const fileService = new FileService(
    db,
    userId,
    chunkedStorage,
    fileNodeRepo,
    trashRepo,
    versionRepo,
    authz,
    quota,
  );

  const uploadService = new UploadService(
    db,
    userId,
    fileService,
    fileNodeRepo,
    sessionRepo,
    quota,
    authz,
    rawStorage,
  );

  const tokenService = new TokenService(tokenRepo, db, userId, authz, quota);

  const oauthClientRepo = new OAuthClientRepository(db);
  const authzCodeRepo = new AuthorizationCodeRepository(db);
  const oauthGrantRepo = new OAuthGrantRepository();
  const refreshTokenRepo = new RefreshTokenRepository(db);
  const oauthService = new OAuthService(
    db,
    userId,
    oauthClientRepo,
    authzCodeRepo,
    tokenRepo,
    oauthGrantRepo,
    refreshTokenRepo,
    quota,
    parseAllowedResources(appContext.config.allowedResources),
  );

  return {
    db,
    fileService,
    uploadService,
    tokenService,
    oauthService,
    userRepo,
  };
}
