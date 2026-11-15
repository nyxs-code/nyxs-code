import { useState } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { BrailleSpinner } from "@/components/ui/braille-spinner";
import { findCreatedSession, openSession, useSessionDirectory } from "@/lib/sessionDirectory";
import { MarkdownText } from "./markdown";

/** The quoted text of a message from another session, without its header (see
 *  attributedMessage). */
function quotedBody(content: string): string {
  const start = content.indexOf("\n\n");
  const body = start >= 0 ? content.slice(start + 2) : content;
  return body
    .split("\n")
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n")
    .trim();
}

/** A session an agent created (CreateSession), as Claude Code Desktop shows it: its title,
 *  whether it is at work, and a click opens it. */
export function CreatedSessionCard({ chatId, title }: { chatId?: string; title: string }) {
  const t = useTranslations().chatUi;
  const session = findCreatedSession(useSessionDirectory(), chatId, title);
  return (
    <button
      type="button"
      disabled={!session}
      onClick={() => session && openSession(session.id)}
      aria-label={`${t.openSession}: ${session?.title || title}`}
      className="my-2 flex w-full max-w-md items-center gap-2 rounded-[8px] border border-bg-300 bg-bg-0 px-3 py-2 text-left text-[13px] text-text-100 transition-colors enabled:hover:bg-bg-200 disabled:opacity-60"
    >
      <MessagesSquare className="h-4 w-4 shrink-0 text-text-400" />
      <span className="min-w-0 flex-1 truncate">{session?.title || title}</span>
      {session?.working && (
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-text-400">
          <BrailleSpinner />
          {t.sessionWorking}
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-text-400" />
    </button>
  );
}

/** A message another session sent here: "Message received from <session>", folded, with the
 *  text it sent underneath. */
export function SessionMessageCard({ from, content }: { from: { id: string; title: string; reply?: boolean }; content: string }) {
  const t = useTranslations().chatUi;
  const [open, setOpen] = useState(false);
  const live = useSessionDirectory().find((e) => e.id === from.id);
  const title = live?.title || from.title || from.id;
  const body = quotedBody(content);
  return (
    <div className="px-4 py-2">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-1 text-[13px] text-text-400">
          <span>{from.reply ? t.sessionReplyFrom : t.sessionMessageFrom}</span>
          <button
            type="button"
            onClick={() => openSession(from.id)}
            disabled={!live}
            className="min-w-0 truncate text-text-200 underline decoration-text-500/50 underline-offset-2 enabled:hover:text-text-100 disabled:no-underline"
          >
            {title}
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? t.hideSessionMessage : t.showSessionMessage}
            className="shrink-0 rounded-[6px] p-0.5 text-text-400 hover:bg-bg-200 hover:text-text-100"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </button>
        </div>
        {open && (
          <div className="mt-1.5 break-words border-l-2 border-bg-300 pl-3 text-text-300">
            <MarkdownText text={body} />
          </div>
        )}
      </div>
    </div>
  );
}
