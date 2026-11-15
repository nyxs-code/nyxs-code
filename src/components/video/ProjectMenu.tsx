import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, MoreHorizontal, PackageOpen } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { exportStandalone, openOutput, type VideoProjectInfo } from "@/lib/video/videoApi";
import { ProjectActionsMenu } from "./ProjectActionsMenu";
import type { ProjectActions } from "./useProjectActions";

/** The ⋯ menu next to the project's name in the editor: the card's actions (rename,
 *  duplicate, show in folder, convert, delete) plus export as a standalone Remotion project. */
export function ProjectMenu({ workspace, project, actions, onError }: { workspace: string; project: VideoProjectInfo; actions: ProjectActions; onError: (message: string | null) => void }) {
  const t = useTranslations().videoPanel;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [exporting, setExporting] = useState(false);

  const exportProject = async () => {
    setMenuAt(null);
    const picked = await openDialog({ directory: true, title: t.exportTitle }).catch(() => null);
    const dest = Array.isArray(picked) ? picked[0] : picked;
    if (!dest) return;
    setExporting(true);
    onError(null);
    try {
      const written = await exportStandalone(workspace, project.slug, dest);
      // Shows the exported folder in the system's file manager.
      void openOutput(written).catch(() => {});
    } catch (e) {
      onError(t.exportFailed.replace("{error}", e instanceof Error ? e.message : String(e)));
    } finally {
      setExporting(false);
    }
  };

  // An adopted Remotion project already is one: nothing to export.
  const exportItem =
    project.kind === "remotion" ? null : (
      <>
        <button
          type="button"
          role="menuitem"
          onClick={() => void exportProject()}
          className="flex w-full items-start gap-2.5 rounded-[5px] px-2 py-1.5 text-left hover:bg-bg-200"
        >
          <PackageOpen className="mt-0.5 h-4 w-4 shrink-0 text-text-300" />
          <span className="min-w-0">
            <span className="block text-[13px] text-text-100">{t.exportStandalone}</span>
            <span className="block text-[11.5px] leading-snug text-text-400">{t.exportHint}</span>
          </span>
        </button>
        <div className="mx-1 my-1 border-t border-bg-300" />
      </>
    );

  const busy = exporting || actions.busy === project.slug;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          if (menuAt) return setMenuAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 4 });
        }}
        aria-label={t.projectMenu}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        data-tooltip={menuAt ? undefined : t.projectMenu}
        className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] transition-colors", menuAt ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200 hover:text-text-100")}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
      </button>
      {menuAt && <ProjectActionsMenu project={project} actions={actions} at={menuAt} onClose={() => setMenuAt(null)} extra={exportItem} />}
    </>
  );
}
