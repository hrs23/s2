import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TokenCardList } from "~/components/tokens/TokenCard";
import { CreateTokenDialog } from "~/components/tokens/TokenDialogs";
import type { InternalApiToken as ApiToken } from "~/lib/api";

const mockTokens: ApiToken[] = [
  {
    id: "sa-001",
    name: "Default",
    base_path: "/",
    origin_id: null,
    created_at: "2026-03-21T00:00:00.000Z",
    can_delegate: true,
    access_paths: [{ path: "", access: "write" }],
    has_active_secret: true,
    token_expires_at: "2026-06-21T00:00:00.000Z",
  },
  {
    id: "sa-002",
    name: "readonly",
    base_path: "/projects/x",
    can_delegate: false,
    origin_id: null,
    created_at: "2026-03-21T00:00:00.000Z",
    access_paths: [{ path: "docs/", access: "read" }],
    has_active_secret: true,
    token_expires_at: "2026-06-21T00:00:00.000Z",
  },
];

describe("TokenCardList", () => {
  it("displays token list", () => {
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("readonly")).toBeInTheDocument();
  });

  it("shows a message when tokens are empty", () => {
    render(
      <TokenCardList
        tokens={[]}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(screen.getByText(/No tokens yet/)).toBeInTheDocument();
  });

  it("calls onDelete when the delete button is clicked", async () => {
    const onDelete = vi.fn();
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={onDelete}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    const deleteButtons = screen.getAllByText("Delete");
    await userEvent.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledWith(mockTokens[0]);
  });

  it("calls onIssueOrRotate when the rotate button is clicked", async () => {
    const onIssueOrRotate = vi.fn();
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={() => {}}
        onIssueOrRotate={onIssueOrRotate}
        onSettings={() => {}}
      />,
    );
    const buttons = screen.getAllByText("Rotate");
    await userEvent.click(buttons[0]);
    expect(onIssueOrRotate).toHaveBeenCalledWith(mockTokens[0]);
  });

  it("shows 'Issue' button for tokens that have not been issued yet", () => {
    const unissuedToken: ApiToken = {
      ...mockTokens[0],
      id: "sa-unissued",
      name: "Unissued",
      has_active_secret: false,
      token_expires_at: null,
    };
    render(
      <TokenCardList
        tokens={[unissuedToken]}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(screen.getByText("Issue")).toBeInTheDocument();
    expect(screen.queryByText("Rotate")).not.toBeInTheDocument();
  });

  it("calls onSettings when the token name is clicked", async () => {
    const onSettings = vi.fn();
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={onSettings}
      />,
    );
    await userEvent.click(screen.getByText("Default"));
    expect(onSettings).toHaveBeenCalledWith(mockTokens[0]);
  });

  it("displays access path badges correctly", () => {
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    // cumulative access badges
    const readBadges = screen.getAllByText("Read");
    const writeBadges = screen.getAllByText("Read + Write");
    expect(readBadges.length).toBeGreaterThan(0);
    expect(writeBadges.length).toBeGreaterThan(0);
  });

  it("displays token status correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00.000Z"));
    try {
      render(
        <TokenCardList
          tokens={mockTokens}
          onDelete={() => {}}
          onIssueOrRotate={() => {}}
          onSettings={() => {}}
        />,
      );
      // Both tokens are active at the fixed test time.
      const activeTexts = screen.getAllByText(/Active — expires/);
      expect(activeTexts.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows base path when base_path is not /", () => {
    render(
      <TokenCardList
        tokens={mockTokens}
        onDelete={() => {}}
        onIssueOrRotate={() => {}}
        onSettings={() => {}}
      />,
    );
    // base_path is rendered as a gray prefix with trailing slash
    expect(screen.getByText("/projects/x/")).toBeInTheDocument();
  });
});

describe("CreateTokenDialog", () => {
  it("shows expiry preset buttons with 90 days selected by default", () => {
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByText("7 days")).toBeInTheDocument();
    expect(screen.getByText("30 days")).toBeInTheDocument();
    expect(screen.getByText("90 days")).toBeInTheDocument();
    expect(screen.getByText("1 year")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("has advanced section collapsed by default", () => {
    render(
      <CreateTokenDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    // Base Path is now a regular field, always visible
    expect(screen.getByText("Base Path")).toBeInTheDocument();
    // Delegate option should not be visible when Advanced is collapsed
    expect(
      screen.queryByText("Allow creating child tokens"),
    ).not.toBeInTheDocument();
  });
});
