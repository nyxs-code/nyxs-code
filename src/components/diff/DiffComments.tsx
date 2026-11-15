import { useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  addDiffComment,
  clearDiffComments,
  removeDiffComment,
  sendDiffReview,
  updateDiffComment,
  useDiffComments,
  type DiffComment,
} from "@/lib/diffComments";

/** The "+" in a diff line's gutter, shown while the line is hovered. */
export function CommentButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations().diffComments;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t.add}
      className="absolute left-0.5 top-0.5 z-[1] flex h-4 w-4 items-center justify-center rounded-[4px] bg-accent text-white opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 transition-opacity"
    >
      <Plus className="h-3 w-3" />
    </button>
  );
}

function CommentEditor({ initial, onSave, onCancel, workspace }: { initial: string; onSave: (text: string) => void; onCancel: () => void; workspace: string }) {
  const t = useTranslations().diffComments;
  const [text, setText] = useState(initial);
  const save = () => { if (text.trim()) onSave(text.trim()); };
  return (
    <div className="my-1 mx-3 rounded-[8px] border border-bg-300 bg-bg-100 p-2 font-sans">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
          // Ctrl+Enter keeps this comment and sends them all, like in Claude Code Desktop.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (text.trim()) onSave(text.trim());
            sendDiffReview(workspace, t);
          }
        }}
        placeholder={t.placeholder}
        rows={3}
        className="w-full resize-y rounded-[6px] border border-bg-300 bg-bg-0 px-2 py-1.5 text-[13px] text-text-100 placeholder:text-text-500 focus:border-accent focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1 rounded-[6px] text-[12.5px] text-text-200 border border-bg-300 bg-bg-0 hover:bg-bg-200">
          {t.cancel}
        </button>
        <button type="button" onClick={save} disabled={!text.trim()} className="px-3 py-1 rounded-[6px] text-[12.5px] font-medium bg-text-100 text-bg-0 hover:opacity-90 disabled:opacity-40">
          {t.save}
        </button>
      </div>
    </div>
  );
}

function CommentCard({ comment, workspace }: { comment: DiffComment; workspace: string }) {
  const t = useTranslations().diffComments;
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentEditor
        initial={comment.text}
        workspace={workspace}
        onCancel={() => setEditing(false)}
        onSave={(text) => { updateDiffComment(workspace, comment.id, text); setEditing(false); }}
      />
    );
  }
  return (
    <div className="my-1 mx-3 flex items-start gap-2 rounded-[8px] border border-bg-300 bg-bg-100 px-2.5 py-1.5 font-sans">
      <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-text-100">{comment.text}</p>
      <button type="button" onClick={() => setEditing(true)} className="shrink-0 text-[12px] text-text-400 hover:text-text-100">{t.edit}</button>
      <button type="button" onClick={() => removeDiffComment(workspace, comment.id)} className="shrink-0 text-[12px] text-text-400 hover:text-red-500">{t.remove}</button>
    </div>
  );
}

/** What a line of the diff can be commented as. */
export interface LineTarget {
  side: "old" | "new";
  line: number;
  code: string;
}

/** Under a diff line: its comments, and the editor while a new one is being written. */
export function LineComments({ workspace, path, target, writing, onDone }: { workspace: string; path: string; target: LineTarget | null; writing: boolean; onDone: () => void }) {
  const all = useDiffComments(workspace);
  if (!target) return null;
  const here = all.filter((c) => c.path === path && c.side === target.side && c.line === target.line);
  if (!here.length && !writing) return null;
  return (
    <>
      {here.map((c) => <CommentCard key={c.id} comment={c} workspace={workspace} />)}
      {writing && (
        <CommentEditor
          initial=""
          workspace={workspace}
          onCancel={onDone}
          onSave={(text) => { addDiffComment(workspace, { path, ...target, text }); onDone(); }}
        />
      )}
    </>
  );
}

/** Above the diff while there are comments: how many, send them all, or drop them. */
export function ReviewBar({ workspace }: { workspace: string }) {
  const t = useTranslations().diffComments;
  const count = useDiffComments(workspace).length;
  if (!count) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-bg-300 bg-bg-100 px-3 py-1.5">
      <MessageSquare className="h-3.5 w-3.5 text-accent" />
      <span className="text-[12.5px] text-text-200">{count === 1 ? t.countOne : t.count.replace("{n}", String(count))}</span>
      <span className="flex-1" />
      <button type="button" onClick={() => clearDiffComments(workspace)} className="text-[12.5px] text-text-400 hover:text-text-100">
        {t.discard}
      </button>
      <button
        type="button"
        onClick={() => sendDiffReview(workspace, t)}
        className={cn("inline-flex items-center gap-1.5 px-3 py-1 rounded-[6px] text-[12.5px] font-medium bg-text-100 text-bg-0 hover:opacity-90")}
      >
        {t.send}
        <kbd className="font-sans text-[11px] opacity-70">Ctrl+Enter</kbd>
      </button>
    </div>
  );
}
