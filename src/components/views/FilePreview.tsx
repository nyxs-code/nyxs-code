import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { tokenize, langFromPath } from "@/lib/highlight";
import { localizedError, useTranslations } from "@/lib/i18n";
import { insideWorkspace, isViewOnlyConfig, toLines } from "@/lib/fileEditing";
import { FileEditor, type LeaveGuard } from "./FileEditor";

const MAX_LINES = 5000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

type Loaded = { path: string } & (
  /** `encoding` names one that isn't UTF-8 ("UTF-16 LE", "Latin-1"): saving can't keep it, so it
   *  opens read-only. */
  | { kind: "text"; text: string; truncated: boolean; mtime: number | null; encoding: string | null }
  | { kind: "image"; src: string }
  | { kind: "none" }
  | { kind: "error"; message: string }
);

/** A file of the Files panel: a project file in an editor (its configuration view-only), an
 *  image, or a read-only view of a file outside the project or too long to edit. */
export function FilePreview({ path, label, refreshKey, workspace, onLeaveGuard }: {
  path: string;
  label: string;
  refreshKey: number;
  workspace: string | null;
  onLeaveGuard?: (guard: LeaveGuard | null) => void;
}) {
  const t = useTranslations().views;
  const te = useTranslations().fileEditor;
  const [result, setResult] = useState<Loaded | null>(null);
  // A result for a previously opened file shows as loading; a refresh of the same file keeps the old content meanwhile.
  const loaded = result?.path === path ? result : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      let next: Loaded;
      try {
        if (IMAGE_EXT.test(path)) {
          const img = await invoke<{ base64: string; mediaType: string }>("agent_read_image", { path });
          next = { path, kind: "image", src: `data:${img.mediaType};base64,${img.base64}` };
        } else {
          const [read, mtime] = await Promise.all([
            invoke<{ text: string; encoding: string | null } | null>("agent_read_text", { path, withEncoding: true }),
            invoke<number | null>("agent_file_mtime", { path }).catch(() => null),
          ]);
          if (read === null) {
            next = { path, kind: "none" };
          } else {
            const all = read.text.replace(/\r\n?/g, "\n").split("\n");
            const truncated = all.length > MAX_LINES;
            const text = (truncated ? all.slice(0, MAX_LINES) : all).join("\n");
            next = { path, kind: "text", text, truncated, mtime, encoding: read.encoding ?? null };
          }
        }
      } catch (e) {
        next = { path, kind: "error", message: localizedError(e) };
      }
      if (alive) setResult(next);
    })();
    return () => { alive = false; };
  }, [path, refreshKey]);

  // Like Claude Code Desktop, files inside the project can be edited; a cut-short view can't.
  const editable = loaded?.kind === "text" && !loaded.truncated && insideWorkspace(path, workspace);
  const encoding = loaded?.kind === "text" ? loaded.encoding : null;
  const readOnly = isViewOnlyConfig(path) || !!encoding;
  const lines = useMemo(
    () => (loaded?.kind === "text" && !editable ? toLines(tokenize(loaded.text, langFromPath(loaded.path))) : []),
    [loaded, editable],
  );

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-2 text-[12px] text-text-400">
        <span className="min-w-0 truncate">{label}</span>
        {editable && readOnly && <span className="shrink-0 text-text-500">· {te.viewOnly}{encoding && ` · ${encoding}`}</span>}
      </div>
      {editable && loaded?.kind === "text" ? (
        <div className="flex-1 min-h-0">
          <FileEditor key={path} path={path} diskText={loaded.text} diskMtime={loaded.mtime} readOnly={readOnly} onLeaveGuard={onLeaveGuard} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
          {!loaded ? (
            <p className="px-4 text-text-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /></p>
          ) : loaded.kind === "error" ? (
            <p className="px-4 text-[12px] text-red-400 break-words">{loaded.message}</p>
          ) : loaded.kind === "none" ? (
            <p className="px-4 text-[12px] text-text-500">{t.cannotPreview}</p>
          ) : loaded.kind === "image" ? (
            <div className="p-4">
              <img src={loaded.src} alt={label} className="max-w-full h-auto rounded-md border border-bg-300 bg-[repeating-conic-gradient(#8881_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]" />
            </div>
          ) : (
            <div className="pb-4 font-mono text-[12.5px] leading-[20px]">
              {lines.map((line, i) => (
                <div key={i} className="flex hover:bg-bg-200/60">
                  <span className="w-12 shrink-0 pr-4 text-right text-text-500 select-none tabular-nums">{i + 1}</span>
                  {/* Long lines wrap under the code, like the chat: no sideways scroll. */}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-6">
                    {line.length === 0 ? " " : line.map((tok, j) => <span key={j} className={tok.cls}>{tok.text}</span>)}
                  </span>
                </div>
              ))}
              {loaded.truncated && (
                <p className="pl-12 pt-2 text-[11px] text-text-500">{t.previewTruncated.replace("{n}", String(MAX_LINES))}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
