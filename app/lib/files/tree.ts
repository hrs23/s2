import type { FileItem } from "~/lib/api";

export interface TreeEntry {
  id?: string;
  name: string;
  type: "file" | "folder";
  fullKey?: string;
  size?: number;
  modified_at?: string;
}

export function parseTree(items: FileItem[], prefix: string): TreeEntry[] {
  const folders = new Set<string>();
  const files: TreeEntry[] = [];

  for (const item of items) {
    // API returns direct children only — item.name is the child name, not a full path.
    // We use prefix to reconstruct the full key for file actions (download/delete).
    const name = item.name;
    if (!name) continue;

    if (item.type === "directory") {
      folders.add(name.replace(/\/$/, ""));
    } else {
      files.push({
        id: item.id,
        name,
        type: "file",
        fullKey: prefix + name,
        size: item.size,
        modified_at: item.modified_at,
      });
    }
  }

  return [
    ...Array.from(folders)
      .sort()
      .map((f) => ({
        name: f,
        type: "folder" as const,
        fullKey: `${prefix}${f}/`,
      })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  ];
}
