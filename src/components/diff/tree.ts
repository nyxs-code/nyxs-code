import type { DiffFile } from "./parse";

// ── File tree ──────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file?: DiffFile;
}

export function buildTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && !c.file === (i < parts.length - 1));
      if (!child) {
        child = { name: part, path, children: [], file: i === parts.length - 1 ? f : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  // Folders with a single folder inside read as one line: ".claude/skills/nyxs-tooltips".
  const compress = (n: TreeNode): TreeNode => {
    let cur = n;
    while (!cur.file && cur.children.length === 1 && !cur.children[0].file) {
      const only = cur.children[0];
      cur = { ...only, name: cur.name ? `${cur.name}/${only.name}` : only.name };
    }
    return { ...cur, children: cur.children.map(compress) };
  };
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .map((n) => ({ ...n, children: sort(n.children) }))
      .sort((x, y) => (!x.file !== !y.file ? (x.file ? 1 : -1) : x.name.localeCompare(y.name, undefined, { sensitivity: "base" })));
  return sort(root.children.map(compress));
}

export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}
