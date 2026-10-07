import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { server } from "~/test/msw-server";
import { ViewFileDialog } from "./file-dialogs";

// Minimal TreeEntry shape needed by ViewFileDialog's version-history branch.
const entry = {
  id: "n1",
  name: "memo.txt",
  type: "file" as const,
  fullKey: "memo.txt",
  size: 5,
  modified_at: "2026-05-17T00:00:00.000Z",
};

beforeEach(() => {
  // Default text-file fetch (called eagerly when the dialog opens).
  server.use(
    http.get("/api/v1/files/memo.txt", () => new HttpResponse("hello")),
  );
});

async function openVersionHistory() {
  render(
    <ViewFileDialog entry={entry} onClose={() => {}} onSaved={() => {}} />,
  );
  const user = userEvent.setup();
  const toggle = await screen.findByRole("button", {
    name: /version history/i,
  });
  await user.click(toggle);
  return user;
}

describe("ViewFileDialog: version restore", () => {
  it("shows the revision-gone message when restore returns 410", async () => {
    // Two revisions: an older one (restorable) + current.
    const revisions = [
      {
        id: "rev_old",
        size: 5,
        content_type: "text/plain",
        hash: "h",
        created_at: "2026-05-16T00:00:00.000Z",
        is_current: false,
      },
      {
        id: "rev_cur",
        size: 5,
        content_type: "text/plain",
        hash: "h",
        created_at: "2026-05-17T00:00:00.000Z",
        is_current: true,
      },
    ];
    server.use(
      http.get("/internal/revisions", () => HttpResponse.json({ revisions })),
      http.post("/internal/files-restore", () =>
        HttpResponse.json(
          {
            error: {
              code: "revision_gone",
              message:
                "This revision is no longer available. It may have been overwritten by recent edits.",
            },
          },
          { status: 410 },
        ),
      ),
    );

    const user = await openVersionHistory();

    // Restore button is shown only for non-current revisions.
    const restoreBtn = await screen.findByRole("button", { name: /restore/i });
    await user.click(restoreBtn);

    await waitFor(() => {
      expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
    });
  });

  it("shows a generic failure message for other restore errors", async () => {
    const revisions = [
      {
        id: "rev_old",
        size: 5,
        content_type: "text/plain",
        hash: "h",
        created_at: "2026-05-16T00:00:00.000Z",
        is_current: false,
      },
      {
        id: "rev_cur",
        size: 5,
        content_type: "text/plain",
        hash: "h",
        created_at: "2026-05-17T00:00:00.000Z",
        is_current: true,
      },
    ];
    server.use(
      http.get("/internal/revisions", () => HttpResponse.json({ revisions })),
      http.post("/internal/files-restore", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: "File was modified concurrently. Refresh and try again.",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const user = await openVersionHistory();
    const restoreBtn = await screen.findByRole("button", { name: /restore/i });
    await user.click(restoreBtn);

    await waitFor(() => {
      expect(screen.getByText(/modified concurrently/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();
  });
});
