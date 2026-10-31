import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import DashboardLayout, { StorageUsage } from "./_dashboard";

describe("StorageUsage", () => {
  it("shows logical usage and filesystem availability for unlimited storage", () => {
    render(
      <StorageUsage
        bytesUsed={16 * 1024}
        storageLimit={0}
        storageAvailableBytes={327 * 1024 ** 3}
      />,
    );

    expect(screen.getByText("16.0 KB used · 327 GB available")).toBeVisible();
    expect(screen.queryByText(/∞/)).not.toBeInTheDocument();
  });

  it("shows only logical usage when filesystem availability is unavailable", () => {
    render(
      <StorageUsage
        bytesUsed={16 * 1024}
        storageLimit={0}
        storageAvailableBytes={null}
      />,
    );

    expect(screen.getByText("16.0 KB used")).toBeVisible();
    expect(screen.queryByText(/∞/)).not.toBeInTheDocument();
  });

  it("preserves finite-limit usage and progress", () => {
    const { container } = render(
      <StorageUsage
        bytesUsed={128 * 1024 ** 2}
        storageLimit={256 * 1024 ** 2}
        storageAvailableBytes={327 * 1024 ** 3}
      />,
    );

    expect(screen.getByText("128.0 MB of 256 MB used")).toBeVisible();
    expect(container.querySelector('[style="width: 50%;"]')).not.toBeNull();
  });
});

describe("DashboardLayout", () => {
  it("signs out through a POST form instead of a GET link", () => {
    const props = {
      loaderData: {
        user: { email: "user@example.com", bytes_used: 0 },
        storageLimit: 0,
        storageAvailableBytes: null,
        appUrl: "http://localhost:8888",
      },
    } as unknown as Parameters<typeof DashboardLayout>[0];
    const { container } = render(
      <MemoryRouter>
        <DashboardLayout {...props} />
      </MemoryRouter>,
    );

    const buttons = screen.getAllByRole("button", { name: "Log out" });
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toHaveAttribute("type", "submit");
      const form = button.closest("form");
      expect(form).toHaveAttribute("method", "post");
      expect(form).toHaveAttribute("action", "/logout");
    }
    expect(container.querySelector('a[href="/logout"]')).toBeNull();
  });
});
