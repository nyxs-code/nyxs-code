import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/components/views/FileIcon";
import { Counts } from "./DiffBody";
import type { TreeNode } from "./tree";

export function TreeItem({
  node,
  depth,
  onPick,
  active,
}: {
  node: TreeNode;
  depth: number;
  onPick: (path: string) => void;
  active: string | null;
}) {
  const [open, setOpen] = useState(true);
  if (node.file) {
    const f = node.file;
    return (
      <button
        type="button"
        onClick={() => onPick(f.path)}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={cn(
          "w-full flex items-center gap-1.5 py-[3px] pr-2 rounded-md text-left text-[13px] transition-colors",
          active === f.path ? "bg-bg-200 text-text-100" : "text-text-200 hover:bg-bg-200/70",
        )}
      >
        <FileIcon name={node.name} className="!w-3.5 !h-3.5" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <Counts added={f.added} removed={f.removed} />
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: depth * 12 + 4 }}
        className="w-full flex items-center gap-1 py-[3px] pr-2 rounded-md text-left text-[13px] text-text-200 hover:bg-bg-200/70 transition-colors"
      >
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-text-400 transition-transform", !open && "-rotate-90")} />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {open && node.children.map((c) => <TreeItem key={c.path} node={c} depth={depth + 1} onPick={onPick} active={active} />)}
    </>
  );
}
