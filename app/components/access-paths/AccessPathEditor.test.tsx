import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AccessPath, AccessPathEditor } from "./AccessPathEditor";

/** Stateful wrapper: the editor is controlled, so tests must thread state
 *  through to see incremental updates from userEvent.type. The spy receives
 *  every onChange call so assertions can read the final committed state. */
function StatefulHarness({
  initial,
  basePath,
  spy,
}: {
  initial: AccessPath[];
  basePath: string;
  spy: (paths: AccessPath[]) => void;
}) {
  const [paths, setPaths] = useState(initial);
  return (
    <AccessPathEditor
      accessPaths={paths}
      onChange={(next) => {
        setPaths(next);
        spy(next);
      }}
      basePath={basePath}
    />
  );
}

function renderEditor(initial: AccessPath[], basePath = "/") {
  const onChange = vi.fn();
  const utils = render(
    <StatefulHarness initial={initial} basePath={basePath} spy={onChange} />,
  );
  return { ...utils, onChange };
}

describe("AccessPathEditor", () => {
  it("renders base_path as immutable prefix label with trailing /", () => {
    renderEditor([{ path: "docs", access: "read" }], "/photos");
    expect(screen.getByText("/photos/")).toBeInTheDocument();
  });

  it("renders prefix label as '/' when base_path is /", () => {
    renderEditor([{ path: "docs", access: "read" }], "/");
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("strips leading / when displaying state in the input field", () => {
    renderEditor([{ path: "docs/2024", access: "read" }], "/");
    expect(screen.getByLabelText("Path 1")).toHaveValue("docs/2024");
  });

  it("displays empty input when path is empty (all under base)", () => {
    renderEditor([{ path: "", access: "write" }], "/photos");
    expect(screen.getByLabelText("Path 1")).toHaveValue("");
  });

  it("typing into an empty input yields the typed relative path", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor([{ path: "", access: "write" }], "/");
    await user.type(screen.getByLabelText("Path 1"), "foo/bar");
    expect(onChange).toHaveBeenLastCalledWith([
      { path: "foo/bar", access: "write" },
    ]);
  });

  it("normalizes leading / when user accidentally types it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor([{ path: "", access: "write" }], "/");
    await user.type(screen.getByLabelText("Path 1"), "/foo");
    expect(onChange).toHaveBeenLastCalledWith([
      { path: "foo", access: "write" },
    ]);
  });

  it("clearing the input sets path back to empty (all under base)", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor([{ path: "docs", access: "read" }], "/");
    await user.clear(screen.getByLabelText("Path 1"));
    expect(onChange).toHaveBeenLastCalledWith([{ path: "", access: "read" }]);
  });

  it("new rows are seeded with an empty path (all under base)", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor([{ path: "docs", access: "read" }], "/");
    await user.click(screen.getByRole("button", { name: /add path/i }));
    const last = onChange.mock.lastCall?.[0] as AccessPath[];
    expect(last).toHaveLength(2);
    expect(last[1]).toEqual({ path: "", access: "write" });
  });
});
