// PUT /api/v1/uploads/:id/:chunk — Upload a single chunk for a session.
// Body: raw chunk bytes (≤4MB). Server stores the chunk.

import type { ActionFunctionArgs } from "react-router";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getAuthContext } from "~/lib/auth/auth.server";
import { createServices } from "~/lib/service-factory.server";
import { CHUNK_SIZE } from "~/lib/storage/chunked.server";
import { readBodyBounded } from "~/lib/utils/bounded-body.server";
import { err } from "~/lib/utils/http.server";

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "PUT") return err(405, "Method Not Allowed");

  const env = getRuntimeEnv(context);
  const auth = await getAuthContext(request, env);
  if (!auth) return err(401, "Unauthorized");

  const sessionId = params.id;
  const chunkIndex = Number(params.chunk);
  if (!sessionId || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return err(400, "Invalid session or chunk index");
  }

  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > CHUNK_SIZE) {
    return err(413, "Chunk exceeds maximum size");
  }
  const chunkBody = await readBodyBounded(request, CHUNK_SIZE);
  if (!chunkBody) return err(413, "Chunk exceeds maximum size");

  const { uploadService } = createServices(
    getAppContext(context),
    auth.user_id,
  );
  const result = await uploadService.uploadChunk(
    auth,
    sessionId,
    chunkIndex,
    chunkBody,
  );

  if (!result.ok) {
    const statusMap = {
      bad_request: 400,
      not_found: 404,
      conflict: 409,
      expired: 410,
      too_large: 413,
    } as const;
    return err(statusMap[result.code], result.message);
  }

  return Response.json({
    chunkIndex: result.chunkIndex,
    size: result.size,
    checksum: result.checksum,
  });
}
