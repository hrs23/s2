import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoveDialog } from "~/components/files/file-dialogs";
import {
  Breadcrumb,
  buildBreadcrumbs,
  FileTree,
} from "~/components/files/file-tree";
import type { FileItem } from "~/lib/api";
import { parseTree } from "~/lib/files/tree";

// Mock items as returned by the API — direct children only (no full paths)
const mockRootItems: FileItem[] = [
  {
    id: "d1",
    name: "notes",
    type: "directory",
    content_version: 0,
    content_type: "inode/directory",
  },
  {
    id: "f4",
    name: "photo.png",
    type: "file",
    size: 1048576,
    modified_at: "2026-03-21T00:00:00.000Z",
    content_version: 1,
    content_type: "image/png",
  },
];

const mockNotesItems: FileItem[] = [
  {
    id: "d2",
    name: "sub",
    type: "directory",
    content_version: 0,
    content_type: "inode/directory",
  },
  {
    id: "f1",
    name: "hello.txt",
    type: "file",
    size: 14,
    modified_at: "2026-03-21T00:00:00.000Z",
    content_version: 1,
    content_type: "text/plain",
  },
  {
    id: "f2",
    name: "world.txt",
    type: "file",
    size: 20,
    modified_at: "2026-03-21T00:00:00.000Z",
    content_version: 1,
    content_type: "text/plain",
  },
];

describe("parseTree", () => {
  it("classifies folders and direct files at root", () => {
    const entries = parseTree(mockRootItems, "");
    expect(entries).toEqual([
      { name: "notes", type: "folder", fullKey: "notes/" },
      {
        id: "f4",
        name: "photo.png",
        type: "file",
        fullKey: "photo.png",
        size: 1048576,
        modified_at: expect.any(String),
      },
    ]);
  });

  it("prepends prefix to fullKey for nested directories", () => {
    const entries = parseTree(mockNotesItems, "notes/");
    expect(entries.map((e) => e.name)).toEqual([
      "sub",
      "hello.txt",
      "world.txt",
    ]);
    expect(entries[0].type).toBe("folder");
    expect(entries[0].fullKey).toBe("notes/sub/");
    expect(entries[1].type).toBe("file");
    // fullKey must include the prefix for download/delete to work
    expect((entries[1] as { fullKey: string }).fullKey).toBe("notes/hello.txt");
  });

  it("returns an empty array when items are empty", () => {
    expect(parseTree([], "")).toEqual([]);
  });
});

describe("buildBreadcrumbs", () => {
  it("returns only My Files for root prefix", () => {
    expect(buildBreadcrumbs("")).toEqual([{ label: "My Files", prefix: "" }]);
  });

  it("decomposes nested prefix into segments", () => {
    const crumbs = buildBreadcrumbs("notes/sub/");
    expect(crumbs).toEqual([
      { label: "My Files", prefix: "" },
      { label: "notes", prefix: "notes/" },
      { label: "sub", prefix: "notes/sub/" },
    ]);
  });
});

const defaultFileTreeProps = {
  onNavigate: () => {},
  onView: () => {},
  onDelete: () => {},
  deletingKey: null,
  onDeleteConfirm: () => {},
  onDeleteCancel: () => {},
  onRename: () => {},
  onMove: () => {},
};

describe("FileTree", () => {
  it("displays files and folders", () => {
    const entries = parseTree(mockRootItems, "");
    render(<FileTree {...defaultFileTreeProps} entries={entries} />);
    expect(screen.getAllByText("notes/").length).toBeGreaterThan(0);
    expect(screen.getAllByText("photo.png").length).toBeGreaterThan(0);
  });

  it("shows a message when empty", () => {
    render(<FileTree {...defaultFileTreeProps} entries={[]} />);
    expect(screen.getByText(/No files/)).toBeInTheDocument();
  });

  it("calls onNavigate when a folder is clicked", async () => {
    const onNavigate = vi.fn();
    const entries = parseTree(mockRootItems, "");
    render(
      <FileTree
        {...defaultFileTreeProps}
        entries={entries}
        onNavigate={onNavigate}
      />,
    );
    await userEvent.click(screen.getAllByText("notes/")[0]);
    expect(onNavigate).toHaveBeenCalledWith("notes");
  });

  it("calls onDelete for files and folders", async () => {
    const onDelete = vi.fn();
    const entries = parseTree(mockRootItems, "");
    render(
      <FileTree
        {...defaultFileTreeProps}
        entries={entries}
        onDelete={onDelete}
      />,
    );
    const deleteBtns = screen.getAllByTitle("Delete");
    // Click all delete buttons — folders and files both have them
    for (const btn of deleteBtns) {
      await userEvent.click(btn);
    }
    expect(onDelete).toHaveBeenCalledWith("notes/");
    expect(onDelete).toHaveBeenCalledWith("photo.png");
  });

  it("calls onRename with the whole entry for files and folders", async () => {
    const onRename = vi.fn();
    const entries = parseTree(mockRootItems, "");
    render(
      <FileTree
        {...defaultFileTreeProps}
        entries={entries}
        onRename={onRename}
      />,
    );
    const renameBtns = screen.getAllByTitle("Rename");
    for (const btn of renameBtns) {
      await userEvent.click(btn);
    }
    // Rename handler receives the full TreeEntry so the dialog can seed
    // the input with the current name and know whether it's a folder.
    expect(onRename).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes", type: "folder" }),
    );
    expect(onRename).toHaveBeenCalledWith(
      expect.objectContaining({ name: "photo.png", type: "file" }),
    );
  });

  it("displays size in human-readable format", () => {
    const entries = parseTree(mockRootItems, "");
    render(<FileTree {...defaultFileTreeProps} entries={entries} />);
    expect(screen.getAllByText("1.0 MB").length).toBeGreaterThan(0);
  });
});

describe("Breadcrumb", () => {
  it("displays My Files for root prefix", () => {
    render(<Breadcrumb prefix="" onNavigate={() => {}} />);
    expect(screen.getByText("My Files")).toBeInTheDocument();
  });

  it("displays all segments for nested paths", () => {
    render(<Breadcrumb prefix="notes/sub/" onNavigate={() => {}} />);
    expect(screen.getByText("My Files")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
  });

  it("does not display double slashes", () => {
    render(<Breadcrumb prefix="notes/sub/" onNavigate={() => {}} />);
    const nav = screen.getByRole("navigation");
    expect(nav.textContent).not.toContain("//");
  });

  it("number of separators = number of breadcrumbs - 1", () => {
    render(<Breadcrumb prefix="notes/sub/" onNavigate={() => {}} />);
    const nav = screen.getByRole("navigation");
    const sepCount = Array.from(nav.querySelectorAll("span")).filter(
      (el) => el.textContent === "/" && el.childElementCount === 0,
    ).length;
    expect(sepCount).toBe(2);
  });

  it("calls onNavigate when clicked", async () => {
    const onNavigate = vi.fn();
    render(<Breadcrumb prefix="notes/sub/" onNavigate={onNavigate} />);
    await userEvent.click(screen.getByText("notes"));
    expect(onNavigate).toHaveBeenCalledWith("notes/");
  });
});

describe("MoveDialog", () => {
  const fileEntry = {
    name: "memo.txt",
    type: "file" as const,
    fullKey: "memo.txt",
  };
  const folderEntry = {
    name: "docs",
    type: "folder" as const,
    fullKey: "docs/",
  };

  it("appends file name to destination folder for files", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MoveDialog
        entry={fileEntry}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "archive/2025/");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onSubmit).toHaveBeenCalledWith(fileEntry, "archive/2025/memo.txt");
  });

  it("appends folder name with trailing slash for folders", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MoveDialog
        entry={folderEntry}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "archive/");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onSubmit).toHaveBeenCalledWith(folderEntry, "archive/docs/");
  });

  it("shows validation error for '..' in path", async () => {
    render(
      <MoveDialog
        entry={fileEntry}
        onOpenChange={() => {}}
        onSubmit={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "../escape/");
    expect(
      screen.getByText("Path cannot contain '.' or '..'"),
    ).toBeInTheDocument();
  });

  it("shows server error inline without closing", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("Destination already exists"));
    render(
      <MoveDialog
        entry={fileEntry}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "archive/");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(
      await screen.findByText("Destination already exists"),
    ).toBeInTheDocument();
  });
});
