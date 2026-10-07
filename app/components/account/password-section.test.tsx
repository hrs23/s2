import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordSection } from "./password-section";

const changePasswordMock = vi.fn();

vi.mock("~/lib/auth.client", () => ({
  authClient: {
    changePassword: (...args: unknown[]) => changePasswordMock(...args),
  },
}));

beforeEach(() => {
  changePasswordMock.mockReset();
});

describe("PasswordSection", () => {
  it("shows the change-password form when the user has a credential account", () => {
    render(<PasswordSection />);

    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /email me a link/i }),
    ).not.toBeInTheDocument();
  });
});
