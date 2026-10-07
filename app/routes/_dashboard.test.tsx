import { render, screen } from "@testing-library/react";
import { StorageUsage } from "./_dashboard";

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
