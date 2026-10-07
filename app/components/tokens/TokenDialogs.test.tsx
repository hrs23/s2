import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InternalApiToken as ApiToken } from "~/lib/api";
import {
  CreateTokenDialog,
  DeleteConfirmDialog,
  EditTokenDialog,
  IssueOrRotateDialog,
  TokenResultDialog,
} from "./TokenDialogs";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockToken: ApiToken = {
  id: "sa-001",
  name: "my-service",
  base_path: "/projects/x",
  can_delegate: false,
  origin_id: null,
  created_at: "2026-03-21T00:00:00.000Z",
  access_paths: [{ path: "docs", access: "read" }],
  has_active_secret: true,
  token_expires_at: "2026-06-21T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// CreateTokenDialog
// ---------------------------------------------------------------------------

describe("CreateTokenDialog", () => {
  it("renders nothing when open=false", () => {
    render(
      <CreateTokenDialog
        open={false}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: /new api token/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the dialog when open=true", () => {
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /new api token/i }),
    ).toBeInTheDocument();
  });

  it("shows base_path validation error for invalid path", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    // Clear the base path input and type an invalid value (no leading /)
    const basePathInput = screen.getByPlaceholderText("/");
    await user.clear(basePathInput);
    await user.type(basePathInput, "no-leading-slash");

    await user.click(screen.getByRole("button", { name: /create/i }));

    // Validation error should show, onSubmit should NOT be called
    await waitFor(() =>
      expect(
        screen.getByText(/base path must start with/i),
      ).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits with default values (name, basePath /, canDelegate false, 90 days)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    // Default name is "my-app", basePath is "/", canDelegate false, 90 days
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "my-app",
        "/",
        false,
        expect.any(Array),
        90,
      ),
    );
  });

  it("advanced toggle reveals delegation checkbox", async () => {
    const user = userEvent.setup();
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );

    // Delegation checkbox should not be visible initially
    expect(
      screen.queryByRole("checkbox", { name: /allow creating child tokens/i }),
    ).not.toBeInTheDocument();

    // Click the Advanced toggle
    await user.click(screen.getByRole("button", { name: /advanced/i }));

    // Now the delegation checkbox should be visible
    expect(
      screen.getByRole("checkbox", { name: /allow creating child tokens/i }),
    ).toBeInTheDocument();
  });

  it("submits with canDelegate=true when delegation checkbox is checked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    // Open advanced, check delegation
    await user.click(screen.getByRole("button", { name: /advanced/i }));
    await user.click(
      screen.getByRole("checkbox", { name: /allow creating child tokens/i }),
    );

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "my-app",
        "/",
        true,
        expect.any(Array),
        90,
      ),
    );
  });

  it("shows duplicate path error when two access paths are identical", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    // Add first path
    await user.click(
      screen.getByRole("button", { name: /limit to specific paths/i }),
    );
    const pathInput = screen.getByRole("textbox", { name: /path 1/i });
    await user.type(pathInput, "/photos");

    // Add second path with the same value
    await user.click(screen.getByRole("button", { name: /add path/i }));
    const pathInputs = screen.getAllByRole("textbox", { name: /path/i });
    await user.type(pathInputs[1], "/photos");

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/duplicate paths are not allowed/i),
      ).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("access path input keeps focus after typing (key stability)", async () => {
    const user = userEvent.setup();
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /limit to specific paths/i }),
    );
    const pathInput = screen.getByRole("textbox", { name: /path 1/i });
    await user.click(pathInput);
    await user.keyboard("a");

    // Input should still be focused after typing
    expect(document.activeElement).toBe(pathInput);
  });

  it("disables the submit button when name is empty", async () => {
    const user = userEvent.setup();
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );

    const nameInput = screen.getByPlaceholderText("e.g. my-app");
    await user.clear(nameInput);

    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// EditTokenDialog
// ---------------------------------------------------------------------------

describe("EditTokenDialog", () => {
  it("renders nothing when apiToken is null", () => {
    render(
      <EditTokenDialog
        apiToken={null}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: /settings/i }),
    ).not.toBeInTheDocument();
  });

  it("initializes fields from the existing token", () => {
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );

    // Dialog title shows generic heading
    expect(
      screen.getByRole("heading", { name: /settings/i }),
    ).toBeInTheDocument();

    // Name field should show the token's name
    const nameInput = screen.getByDisplayValue("my-service");
    expect(nameInput).toBeInTheDocument();

    // Base path field should show the token's base_path
    const basePathInput = screen.getByDisplayValue("/projects/x");
    expect(basePathInput).toBeInTheDocument();

    // Delegation checkbox should reflect the token's can_delegate (false)
    const delegateCheckbox = screen.getByRole("checkbox", {
      name: /allow creating child tokens/i,
    });
    expect(delegateCheckbox).not.toBeChecked();
  });

  it("submits changes when save is clicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    // Toggle delegation checkbox on
    const delegateCheckbox = screen.getByRole("checkbox", {
      name: /allow creating child tokens/i,
    });
    await user.click(delegateCheckbox);

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "sa-001",
        "my-service",
        "/projects/x",
        true,
        expect.any(Array),
      ),
    );
    // Dialog should close on success
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("allows renaming the token", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const nameInput = screen.getByDisplayValue("my-service");
    await user.clear(nameInput);
    await user.type(nameInput, "new-name");

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "sa-001",
        "new-name",
        "/projects/x",
        false,
        expect.any(Array),
      ),
    );
  });

  it("disables save when name is empty", async () => {
    const user = userEvent.setup();
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );

    const nameInput = screen.getByDisplayValue("my-service");
    await user.clear(nameInput);

    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("lets the user clear the base path without snapping back to the server value", async () => {
    const user = userEvent.setup();
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );

    const basePathInput = screen.getByDisplayValue("/projects/x");
    await user.clear(basePathInput);

    expect(basePathInput).toHaveValue("");
  });

  it("lets the user remove all access paths without them re-appearing", async () => {
    const user = userEvent.setup();
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );

    // AccessPathEditor renders "/docs" with the leading slash stripped.
    const pathInput = screen.getByDisplayValue("docs");
    expect(pathInput).toBeInTheDocument();

    const removeButton = screen.getByRole("button", { name: /^remove$/i });
    await user.click(removeButton);

    // After removing the only access path, the editor shows the "all paths"
    // empty state instead of re-adding the original row.
    expect(screen.queryByDisplayValue("docs")).not.toBeInTheDocument();
  });

  it("removing all rows submits the canonical full-access record", async () => {
    // 0 rows in the editor is the canonical
    // "full access under base_path" intent. Both Create and Edit silently
    // submit [{path: "", access: "write"}] so the server (which still
    // rejects literal []) sees a valid scope.
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EditTokenDialog
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );

    const removeButton = screen.getByRole("button", { name: /^remove$/i });
    await user.click(removeButton);

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "sa-001",
        "my-service",
        "/projects/x",
        false,
        [{ path: "", access: "write" }],
      ),
    );
  });

  it("re-initializes from the new token when remounted via key", () => {
    const otherToken: ApiToken = {
      ...mockToken,
      id: "sa-002",
      name: "other-service",
      base_path: "/teams/y",
      access_paths: [{ path: "notes", access: "write" }],
    };

    const { rerender } = render(
      <EditTokenDialog
        key={mockToken.id}
        apiToken={mockToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByDisplayValue("my-service")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/projects/x")).toBeInTheDocument();

    rerender(
      <EditTokenDialog
        key={otherToken.id}
        apiToken={otherToken}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );

    expect(screen.getByDisplayValue("other-service")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/teams/y")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IssueOrRotateDialog
// ---------------------------------------------------------------------------

describe("IssueOrRotateDialog", () => {
  it("renders nothing when apiToken is null", () => {
    render(
      <IssueOrRotateDialog
        apiToken={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: /rotate/i }),
    ).not.toBeInTheDocument();
  });

  it("shows expiry options and the token name", () => {
    render(
      <IssueOrRotateDialog
        apiToken={mockToken}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /rotate token/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("my-service")).toBeInTheDocument();

    // Expiry presets
    expect(screen.getByRole("button", { name: "7 days" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 days" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "90 days" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 year" })).toBeInTheDocument();
  });

  it("calls onConfirm with default 90-day expiry", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <IssueOrRotateDialog
        apiToken={mockToken}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rotate/i }));

    expect(onConfirm).toHaveBeenCalledWith("sa-001", 90);
  });

  it("calls onConfirm with selected expiry preset", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <IssueOrRotateDialog
        apiToken={mockToken}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    // Select 30 days
    await user.click(screen.getByRole("button", { name: "30 days" }));
    await user.click(screen.getByRole("button", { name: /rotate/i }));

    expect(onConfirm).toHaveBeenCalledWith("sa-001", 30);
  });

  it("calls onCancel when cancel is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <IssueOrRotateDialog
        apiToken={mockToken}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows 'Issue token' title and non-destructive button for unissued tokens", () => {
    const unissuedToken: ApiToken = {
      ...mockToken,
      has_active_secret: false,
      token_expires_at: null,
    };
    render(
      <IssueOrRotateDialog
        apiToken={unissuedToken}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /issue token/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /rotate/i }),
    ).not.toBeInTheDocument();

    // The confirm button should say "Issue" not "Rotate"
    const issueBtn = screen.getByRole("button", { name: /^issue$/i });
    expect(issueBtn).toBeInTheDocument();
    // Should not have destructive variant (no bg-destructive class)
    expect(issueBtn.className).not.toMatch(/destructive/);
  });
});

// ---------------------------------------------------------------------------
// DeleteConfirmDialog
// ---------------------------------------------------------------------------

describe("DeleteConfirmDialog", () => {
  it("renders nothing when apiToken is null", () => {
    render(
      <DeleteConfirmDialog
        apiToken={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: /delete/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the token name in the confirmation message", () => {
    render(
      <DeleteConfirmDialog
        apiToken={mockToken}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /delete api token/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("my-service")).toBeInTheDocument();
  });

  it("calls onConfirm with token id when confirmed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        apiToken={mockToken}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalledWith("sa-001");
  });

  it("calls onCancel when cancel is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog
        apiToken={mockToken}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TokenResultDialog
// ---------------------------------------------------------------------------

describe("TokenResultDialog", () => {
  it("renders nothing when result is null", () => {
    render(<TokenResultDialog result={null} onClose={() => {}} />);
    expect(
      screen.queryByText(/this token will only be shown once/i),
    ).not.toBeInTheDocument();
  });

  it("shows the token masked by default with reveal toggle", async () => {
    const user = userEvent.setup();
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(/this token will only be shown once/i),
    ).toBeInTheDocument();
    // Token should be masked by default — prefix visible, rest hidden
    expect(screen.getByText(/^s2_test•+$/)).toBeInTheDocument();
    // Raw token must not appear anywhere in the dialog (including agent/curl text)
    const dialog = document.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.textContent).not.toContain("s2_test_secret_token");

    // Click all show buttons to reveal
    const showButtons = screen.getAllByTitle("Show token");
    for (const btn of showButtons) {
      await user.click(btn);
    }
    expect(screen.getByText("s2_test_secret_token")).toBeInTheDocument();

    // Click all hide buttons to hide again
    const hideButtons = screen.getAllByTitle("Hide token");
    for (const btn of hideButtons) {
      await user.click(btn);
    }
    expect(dialog.textContent).not.toContain("s2_test_secret_token");
  });

  it("calls onClose when Done is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("defaults to the AI agent tab", () => {
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={() => {}}
        appUrl="https://example.com"
      />,
    );

    // Agent tab content should be visible
    expect(screen.getByText(/llms\.txt/)).toBeInTheDocument();
  });

  it("switches to REST API tab on click", async () => {
    const user = userEvent.setup();
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={() => {}}
        appUrl="https://example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: /rest api/i }));

    // curl command should appear; agent text should be gone
    expect(screen.getByText(/curl/i)).toBeInTheDocument();
    expect(screen.queryByText(/llms\.txt/)).not.toBeInTheDocument();
  });

  it("switches to WebDAV tab and shows URL + masked token", async () => {
    const user = userEvent.setup();
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={() => {}}
        appUrl="https://example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: /webdav/i }));

    // DAV URL is shown (origin + /dav)
    expect(
      screen.getByText(new RegExp(`${window.location.origin}/dav`)),
    ).toBeInTheDocument();
    // Password label is present, token is masked by default
    expect(screen.getByText(/password/i)).toBeInTheDocument();
    const dialog = document.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.textContent).not.toContain("s2_test_secret_token");
    // Other tabs' content should be gone
    expect(screen.queryByText(/llms\.txt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/curl/i)).not.toBeInTheDocument();
  });

  it("WebDAV tab has a QR reveal button (hidden by default)", async () => {
    const user = userEvent.setup();
    render(
      <TokenResultDialog
        result={{
          token: "s2_test_secret_token",
          expires_at: "2026-06-21T00:00:00.000Z",
        }}
        onClose={() => {}}
        appUrl="https://example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: /webdav/i }));

    // Show QR button is visible; hide control is not
    expect(
      screen.getByRole("button", { name: /show qr/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /hide qr/i }),
    ).not.toBeInTheDocument();

    // Click to reveal → hide control appears
    await user.click(screen.getByRole("button", { name: /show qr/i }));
    expect(
      screen.getByRole("button", { name: /hide qr/i }),
    ).toBeInTheDocument();
  });
});
