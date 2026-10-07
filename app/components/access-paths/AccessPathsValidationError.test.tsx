import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccessPathsValidationError } from "./AccessPathsValidationError";

describe("AccessPathsValidationError", () => {
  it("renders nothing when error is null", () => {
    const { container } = render(<AccessPathsValidationError error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the duplicate message for duplicate_paths", () => {
    render(<AccessPathsValidationError error={{ kind: "duplicate_paths" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /duplicate paths are not allowed/i,
    );
  });

  it("renders the min-rows message for min_rows", () => {
    render(<AccessPathsValidationError error={{ kind: "min_rows" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /add at least one path/i,
    );
  });
});
