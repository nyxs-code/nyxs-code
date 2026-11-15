import { useEffect, useRef, useState } from "react";
import { Paperclip, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { QueuedMessage } from "@/lib/messageQueue";
import type { SendPayload } from "@/components/ui/claude-style-chat-input";
import { isComposingKey } from "@/lib/imeKeys";

function attachmentCount(payload: SendPayload): number {
  return payload.files.length + payload.pastedContent.length + (payload.elements?.length ?? 0);
}

function QueuedBubble({
  item,
  inFlight,
  onEdit,
  onRemove,
  onSendNow,
}: {
  item: QueuedMessage<SendPayload>;
  inFlight: boolean;
  onEdit: (text: string) => void;
  onRemove: () => void;
  onSendNow: () => void;
}) {
  const t = useTranslations().queue;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const text = item.displayText ?? item.payload.message;
  const attachments = attachmentCount(item.payload);
  // Pasted snippets and a picked element have no preview of their own: they stay a count.
  const extras = attachments - item.payload.files.length;

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next && !attachments) onRemove();
    else if (next !== text.trim()) onEdit(next);
  };

  return (
    <div className="group flex justify-end px-4 py-2 animate-fade-in">
      <div className="flex max-w-[80%] flex-col items-end">
        {editing ? (
          <textarea
            ref={inputRef}
            value={draft}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="w-[28rem] max-w-full resize-none rounded-[8px] border border-accent bg-bg-0 px-3.5 py-1.5 text-text-100 outline-none"
          />
        ) : (
          <div className="flex flex-col items-end gap-1.5 opacity-70">
            {/* What's attached shows as it will in the chat: image thumbnails and file names,
                rather than a bare count next to an empty bubble. */}
            {item.payload.files.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {item.payload.files.map((f) =>
                  f.type.startsWith("image/") && f.preview ? (
                    <img key={f.id} src={f.preview} alt={f.file.name} className="h-14 w-14 rounded border border-bg-300 object-cover" />
                  ) : (
                    <span
                      key={f.id}
                      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-bg-300 bg-bg-100 px-2 py-1 text-[12px] text-text-300"
                    >
                      <Paperclip className="h-3 w-3 shrink-0" />
                      <span className="truncate">{f.file.name}</span>
                    </span>
                  ),
                )}
              </div>
            )}
            {(text || extras > 0) && (
              <div className="w-fit whitespace-pre-wrap break-words rounded-[8px] bg-[color:var(--user-bubble)] px-3.5 py-1.5 text-text-100">
                {text}
                {extras > 0 && (
                  <span className={cn("inline-flex items-center gap-0.5 align-middle text-[11px] text-text-400", text && "ml-2")}>
                    <Paperclip className="h-3 w-3" />
                    {extras}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {!editing && (
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-text-400">
            {!inFlight && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(item.payload.message);
                    setEditing(true);
                  }}
                  className="rounded p-0.5 opacity-0 transition-opacity hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                  data-tooltip={t.edit}
                  aria-label={t.edit}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={onRemove}
                  className="rounded p-0.5 opacity-0 transition-opacity hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                  data-tooltip={t.remove}
                  aria-label={t.remove}
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            )}
            <button type="button" onClick={onSendNow} className="hover:text-text-100 transition-colors">
              {t.sendNow}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageQueue({
  items,
  delivering,
  paused,
  onEdit,
  onRemove,
  onSendNow,
  onResume,
}: {
  items: QueuedMessage<SendPayload>[];
  delivering: QueuedMessage<SendPayload>[];
  paused: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onResume: () => void;
}) {
  const t = useTranslations().queue;
  if (!items.length && !delivering.length) return null;
  return (
    <div>
      {[...delivering, ...items].map((item) => (
        <QueuedBubble
          key={item.id}
          item={item}
          inFlight={delivering.includes(item)}
          onEdit={(text) => onEdit(item.id, text)}
          onRemove={() => onRemove(item.id)}
          onSendNow={() => onSendNow(item.id)}
        />
      ))}
      {paused && items.length > 0 && (
        <div className={cn("flex justify-end gap-1.5 px-4 pb-2 text-[12px] text-text-400")}>
          <span>{t.paused}</span>
          <span>·</span>
          <button type="button" onClick={onResume} className="hover:text-text-100 transition-colors">
            {t.resume}
          </button>
        </div>
      )}
    </div>
  );
}

export default MessageQueue;
