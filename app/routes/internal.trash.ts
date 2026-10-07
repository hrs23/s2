// GET /internal/trash — List trash items (cookie-only)
// DELETE /internal/trash — Empty all trash (cookie-only)

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { withAuth } from "~/lib/utils/http.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(args, {}, async ({ auth, services: { fileService } }) => {
    const { items } = await fileService.listTrash(auth);

    return Response.json({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.isDirectory ? "directory" : "file",
        size: item.size ?? 0,
        deleted_at: item.deletedAt,
      })),
    });
  });
}

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "DELETE" },
    async ({ auth, services: { fileService } }) => {
      await fileService.purgeAllTrash(auth);

      return new Response(null, { status: 204 });
    },
  );
}
