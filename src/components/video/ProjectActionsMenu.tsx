import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Copy, FolderOpen, Pencil, RefreshCcw, Trash2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { VideoProjectInfo } from "@/lib/video/videoApi";
import type { ProjectActions } from "./useProjectActions";

interface Props {
  project: VideoProjectInfo;
  actions: ProjectActions;
  /** Viewport point the menu opens at (a click, or under the ⋯ button). */
  at: { x: number; y: number };
  onClose: () => void;
  /** Extra items above the project ones (the editor's "Export as standalone…"). */
  extra?: ReactNode;
}

/** A project's menu: rename, duplicate, show in folder, convert (old format), delete. */
export function ProjectActionsMenu({ project, actions, at, onClose, extra }: Props) {
  const t = useTranslations().videoPanel;
  const ref = useRef<HTMLDivElement>(null);
  // Kept inside the window when opened near an edge (measured, so written straight to the style).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4))}px`;
  }, [at]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const item = (icon: ReactNode, label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1 text-left text-[13px] hover:bg-bg-200",
        danger ? "text-red-600 dark:text-red-400" : "text-text-100",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
  const ic = "h-4 w-4 shrink-0 text-text-300";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t.projectMenu}
      data-webview-hole
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] w-60 rounded-[5px] border border-bg-300 bg-bg-100 p-1 shadow-lg"
      style={{ left: at.x, top: at.y }}
    >
      {extra}
      {/* An adopted Remotion project keeps its own folder name; the backend refuses it. */}
      {project.kind !== "remotion" && item(<Pencil className={ic} />, t.renameProject, () => actions.startRename(project.slug))}
      {project.kind === "nyxs" && item(<Copy className={ic} />, t.duplicateProject, () => actions.duplicate(project))}
      {item(<FolderOpen className={ic} />, t.showInFolder, () => actions.reveal(project))}
      {project.kind === "legacy" && item(<RefreshCcw className={ic} />, t.convertLight, () => actions.convert(project))}
      <div className="mx-1 my-1 border-t border-bg-300" />
      {item(<Trash2 className="h-4 w-4 shrink-0" />, t.deleteProject, () => actions.requestDelete(project), true)}
    </div>
  );
}

