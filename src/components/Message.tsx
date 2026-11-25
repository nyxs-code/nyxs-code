import { useState, useEffect, useRef, useMemo, memo, type ReactNode } from "react";
import {
  Copy,
  Check,
  CheckCheck,
  FileText,
  ChevronRight,
  RotateCcw,
  Pencil,
  ListTodo,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Circle, CircleDot, CheckCircle2, Target } from "lucide-react";
import type { ModelMessage } from "ai";
import type { ToolDetail, Todo } from "@/lib/agentTools";
import type { ImageAttachment } from "@/lib/ai";
import { formatFileSize, type DocumentAttachment } from "@/lib/fileAttachments";
import { pickedElementsOf, type PickedElement } from "@/lib/pickedElement";
import type { TextHighlight } from "@/lib/chatHighlights";
import { ImageLightbox } from "@/components/ImageLightbox";
import { ElementChip } from "@/components/ui/claude-style-chat-input";
import { useTranslations, LANG_KEY } from "@/lib/i18n";
import { moveCommandsToBackground, useHasMovableCommand } from "@/lib/commandBackground";
import { relativeTime, fullDateTime } from "@/lib/time";
import type { RetryState } from "@/lib/useStreamingChats";
import { parseMessage, type Segment, type ToolEnd } from "./message/parse";
import { MarkdownText, CodeBlock } from "./message/markdown";
import { RunnableCommand } from "./message/RunnableCommand";
import { isShellLang } from "./message/commandRun";
import { InlinePreview } from "./message/InlinePreview";
import { ReviewCard } from "./message/ReviewCard";
import { WorkTrace, ReasoningSummary, type TraceNotice } from "./message/WorkTrace";
import { LiveStatus } from "./message/LiveStatus";
import { livePhaseOf, tokensLabel, withTurnStatus, type ReasoningTimes, type WorkItem } from "./message/liveFormat";
import { TurnChanges } from "./message/TurnChanges";
import { CreatedSessionCard, SessionMessageCard } from "./message/SessionCards";
import { CutOffNotice } from "./message/CutOffNotice";
import { OutputLimitNotice } from "./message/OutputLimitNotice";
import type { OutputLimitHit } from "@/lib/agentTurn";
import { isComposingKey } from "@/lib/imeKeys";
import { ariaKeys, useShortcutLabel } from "@/lib/keyBindings";
import type { GoalNotice } from "@/lib/goal";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;

  toolData?: Record<string, ToolDetail>;

  todos?: Todo[];

  startedAt?: number;

  createdAt?: number;

  tokens?: number;

  images?: ImageAttachment[];

  pasted?: string[];

  documents?: DocumentAttachment[];

  elements?: PickedElement[];

  /** Text the user highlighted in this message while reading. */
  highlights?: TextHighlight[];

  /** Line counts of the files this turn's subagents edited, by path (their tool calls aren't in
   *  `toolData`). */
  subagentEdits?: Record<string, { added: number; removed: number }>;

  /** Messages saved before several elements could be picked. Read through pickedElementsOf. */
  element?: PickedElement;

  reasoning?: string;

  reasoningData?: Record<string, string>;

  reasoningTimes?: Record<string, { start: number; end: number }>;

  responseMessages?: ModelMessage[];

  changedFiles?: string[];

  usage?: { inputTokens: number; outputTokens: number; readTokens: number; creationTokens: number; costUsd?: number };

  /** The model ran out of output tokens in this reply. */
  outputLimit?: OutputLimitHit;

  /** The app closed or crashed while this reply ran and didn't carry it on by itself: the model
   *  it ran on, so "Continue" picks it up there. */
  cutOff?: { modelId: string; thinking: boolean };

  /** A turn the app started on the user's behalf: background work finished, or a reload of
   *  the app cut the previous reply short and the agent carries on ("resume"). */
  notice?: {
    kind: "background" | "resume" | "goal";
    items: { id?: string; title: string; status: string; code: number | null; lines?: number }[];
    /** kind "goal": what a goal check found (goalMode.ts). */
    goal?: GoalNotice;
  };

  /** A message another session sent (SendToSession, or the reply of a session this one created):
   *  shown as a card naming that session, with a link to it. `content` keeps the quoted text the
   *  model reads. */
  fromSession?: { id: string; title: string; reply?: boolean };
}

function MessageImages({ images }: { images: ImageAttachment[] }) {
  const tx = useTranslations().messageExtra;
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-1.5 justify-end">
      {images.map((img, i) => (
        <button
          key={i}
          type="button"
          onClick={() => setViewing(img)}
          data-tooltip={img.name}
          className="block cursor-zoom-in"
        >
          <img
            src={img.dataUrl}
            alt={img.name ?? tx.attachedImage}
            className="w-28 h-28 object-cover rounded-[8px] border border-bg-300 hover:border-text-400 transition-colors"
          />
        </button>
      ))}
      {viewing && <ImageLightbox src={viewing.dataUrl} alt={viewing.name} onClose={() => setViewing(null)} />}
    </div>
  );
}

function MessageDocuments({ documents }: { documents: DocumentAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open === null ? null : documents[open];
  return (
    <div className="flex flex-col items-end gap-2 mb-1.5 w-full">
      <div className="flex flex-wrap gap-2 justify-end">
        {documents.map((doc, i) => (
          <button
            key={i}
            type="button"
            onClick={() => doc.text !== undefined && setOpen(open === i ? null : i)}
            data-tooltip={doc.path ?? doc.name}
            className={cn(
              "w-24 h-24 rounded-[8px] border border-bg-300 bg-bg-200 p-3 flex flex-col justify-between text-left transition-colors",
              doc.text !== undefined ? "cursor-pointer hover:border-text-400" : "cursor-default",
              open === i && "border-text-400",
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="p-1.5 bg-bg-300 rounded shrink-0">
                <FileText className="w-4 h-4 text-text-300" />
              </span>
              <span className="text-[10px] font-medium text-text-400 uppercase tracking-wider truncate">{doc.name.includes(".") ? doc.name.split(".").pop() : "file"}</span>
            </span>
            <span className="block space-y-0.5 min-w-0">
              <span className="block text-xs font-medium text-text-200 truncate">{doc.name}</span>
              <span className="block text-[10px] text-text-500">{formatFileSize(doc.size)}</span>
            </span>
          </button>
        ))}
      </div>
      {shown?.text !== undefined && (
        <pre className="w-full max-h-80 overflow-auto rounded-[8px] border border-bg-300 bg-bg-200 p-3 text-[11px] text-text-200 leading-[1.5] font-mono whitespace-pre-wrap break-words animate-fade-in">
          {shown.text}
        </pre>
      )}
    </div>
  );
}

function MessagePasted({ pasted }: { pasted: string[] }) {
  const tx = useTranslations().messageExtra;
  const [open, setOpen] = useState<number | null>(null);
  if (pasted.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-1.5 justify-end">
      {pasted.map((text, i) =>
        open === i ? (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(null)}
            className="w-full max-w-full text-left rounded-[8px] border border-bg-300 bg-bg-200 p-3 animate-fade-in"
          >
            <pre className="text-[11px] text-text-200 leading-[1.5] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto">{text}</pre>
            <span className="mt-2 inline-block text-[9px] font-bold text-text-400 uppercase tracking-wider">{tx.pastedClickCollapse}</span>
          </button>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(i)}
            data-tooltip={`${text.split("\n").length} lines`}
            className="relative group w-28 h-28 rounded-[8px] overflow-hidden border border-bg-300 bg-bg-200 p-3 flex flex-col justify-between animate-fade-in cursor-pointer hover:border-text-400 transition-colors"
          >
            <p className="text-[10px] text-text-400 leading-[1.4] font-mono break-words whitespace-pre-wrap line-clamp-4 select-none text-left">{text}</p>
            <span className="self-start inline-flex items-center px-1.5 py-[2px] rounded border border-bg-300 text-[9px] font-bold text-text-400 uppercase tracking-wider">{tx.pasted}</span>
          </button>
        ),
      )}
    </div>
  );
}

function TodoIcon({ status }: { status: Todo["status"] }) {
  const Icon = status === "completed" ? CheckCircle2 : status === "in_progress" ? CircleDot : Circle;
  const color =
    status === "completed" ? "text-green-400" : status === "in_progress" ? "text-accent" : "text-text-400";
  return (
    <span className="relative w-4 h-4 shrink-0 mt-0.5">
      <motion.span
        key={status}
        initial={{ scale: 0.4, opacity: 0 }}
        animate={status === "in_progress" ? { scale: [1, 1.18, 1], opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={
          status === "in_progress"
            ? { scale: { duration: 1.4, repeat: Infinity, ease: "easeInOut" }, opacity: { duration: 0.2 } }
            : status === "completed"
              ? { type: "spring", stiffness: 500, damping: 22 }
              : { duration: 0.2 }
        }
        className="absolute inset-0"
      >
        <Icon className={cn("w-4 h-4", color)} />
      </motion.span>
    </span>
  );
}

function todoLabel(t: Todo): string {
  if (t.status === "in_progress" && t.activeForm) return t.activeForm;
  return (t.content || t.activeForm || "").trim();
}

function TodoList({ todos }: { todos: Todo[] }) {
  const tMsg = useTranslations().message;
  if (!Array.isArray(todos)) return null;
  const items = todos.filter((t) => t && todoLabel(t).length > 0);
  if (items.length === 0) return null;
  const doneCount = items.filter((t) => t.status === "completed").length;
  const pct = items.length ? (doneCount / items.length) * 100 : 0;
  const seen = new Map<string, number>();
  const rows = items.map((t) => {
    const n = seen.get(t.content) ?? 0;
    seen.set(t.content, n + 1);
    return { t, key: n === 0 ? t.content : `${t.content}#${n}` };
  });
  return (
    <div className="my-2 rounded-[8px] border border-bg-300 bg-bg-100/60 p-3">
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="text-[12px] font-semibold text-text-200 uppercase tracking-wider">{tMsg.tasks}</span>
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
          <div className="h-1 w-full max-w-[140px] rounded-full bg-bg-300 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={{ type: "spring", stiffness: 200, damping: 28 }}
            />
          </div>
          <span className="text-[11px] text-text-400 tabular-nums shrink-0">{doneCount}/{items.length}</span>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {rows.map(({ t, key }) => {
            const label = todoLabel(t);
            return (
              <motion.li
                key={key}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                className="flex items-start gap-2 text-[14px]"
              >
                <TodoIcon status={t.status} />
                <span
                  className={cn(
                    "leading-relaxed transition-colors duration-300",
                    t.status === "completed" && "line-through text-text-400",
                    t.status === "in_progress" && "text-text-100 font-medium",
                    t.status === "pending" && "text-text-300",
                  )}
                >
                  {label}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}

/** A message that is just a slash command ("/create-pr", "/commit fix the typo"), shown the way
 *  it was typed: the command highlighted, then its arguments. */
function slashCommandOf(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

function renderSegment(
  seg: Segment,
  i: number,
  todos: Todo[],
  onOpenView?: (view: string) => void,
  writing = false,
) {
  switch (seg.type) {
    case "code":
      if (seg.lang.toLowerCase() === "preview") return <InlinePreview key={i} html={seg.content} closed={seg.closed} />;
      if (seg.lang.toLowerCase() === "nyxs-review") return <ReviewCard key={i} content={seg.content} closed={seg.closed} />;
      if (isShellLang(seg.lang)) return <RunnableCommand key={i} lang={seg.lang} content={seg.content} closed={seg.closed} />;
      return <CodeBlock key={i} lang={seg.lang} content={seg.content} />;
    case "todo":
      return <TodoList key={i} todos={todos} />;
    case "plan":
      return <PlanButton key={i} onOpenView={onOpenView} />;
    case "reasoning":
    case "tool":
      return null;
    default: {
      const trimmed = seg.content.replace(/^\n+|\n+$/g, "");
      if (!trimmed) return null;
      return <MarkdownText key={i} text={trimmed} streaming={writing} />;
    }
  }
}

function renderSegments(
  segments: Segment[],
  endMap: Map<string, ToolEnd>,
  streaming: boolean,
  toolData: Record<string, ToolDetail>,
  todos: Todo[],
  onOpenView?: (view: string) => void,
  awaitingPermission = false,
  reasoningData: Record<string, string> = {},
  reasoningTimes: ReasoningTimes = {},
  leadNotices: TraceNotice[] = [],
  chatId?: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  let pendingNotices = leadNotices;
  const noticeTrace = (key: string) => (
    <WorkTrace
      key={key}
      items={[]}
      endMap={endMap}
      streaming={streaming}
      toolData={toolData}
      awaitingPermission={awaitingPermission}
      reasoningData={reasoningData}
      reasoningTimes={reasoningTimes}
      notices={pendingNotices}
      onOpenView={onOpenView}
    />
  );

  let lastMeaningfulIdx = -1;
  for (let k = segments.length - 1; k >= 0; k--) {
    const s = segments[k];
    if (s.type === "text" && !s.content.trim()) continue;
    lastMeaningfulIdx = k;
    break;
  }

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];

    if (seg.type === "tool" || seg.type === "reasoning") {
      const notices = pendingNotices;
      pendingNotices = [];
      const items: WorkItem[] = [];
      let j = i;
      while (j < segments.length) {
        const s = segments[j];
        if (s.type === "tool") {
          items.push({ kind: "tool", id: s.id, name: s.name, detail: s.detail });
        } else if (s.type === "reasoning") {
          items.push({ kind: "reasoning", id: s.id, active: streaming && j === lastMeaningfulIdx });
        } else if (!(s.type === "text" && !s.content.trim())) {
          break;
        }
        j++;
      }
      out.push(
        <WorkTrace
          key={`work-${i}`}
          items={items}
          endMap={endMap}
          streaming={streaming}
          toolData={toolData}
          awaitingPermission={awaitingPermission}
          reasoningData={reasoningData}
          reasoningTimes={reasoningTimes}
          notices={notices}
          onOpenView={onOpenView}
        />,
      );
      // Each session the agent created gets its card under the work, as in Claude Code Desktop:
      // one per title, and none for a call that failed (the session wasn't created).
      const carded = new Set<string>();
      for (const it of items) {
        if (it.kind !== "tool" || it.name !== "CreateSession" || !it.detail) continue;
        if (endMap.get(it.id)?.status === "err" || carded.has(it.detail.toLowerCase())) continue;
        carded.add(it.detail.toLowerCase());
        out.push(<CreatedSessionCard key={`session-${it.id}`} chatId={chatId} title={it.detail} />);
      }
      i = j;
      continue;
    }

    if (pendingNotices.length && !(seg.type === "text" && !seg.content.trim())) {
      out.push(noticeTrace("notices"));
      pendingNotices = [];
    }

    const writing = streaming && i === lastMeaningfulIdx && seg.type === "text";
    out.push(renderSegment(seg, i, todos, onOpenView, writing));
    i++;
  }
  if (pendingNotices.length) out.unshift(noticeTrace("notices"));
  return out;
}

function PlanButton({ onOpenView }: { onOpenView?: (view: string) => void }) {
  const tMsg = useTranslations().message;
  return (
    <button
      onClick={() => onOpenView?.("plan")}
      className="my-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] font-medium text-text-100 hover:bg-accent/15 transition-colors"
    >
      <FileText className="w-4 h-4 text-accent" />
      {tMsg.viewPlan}
      <ChevronRight className="w-3.5 h-3.5 text-text-400" />
    </button>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const tMsg = useTranslations().message;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="inline-flex items-center text-text-400 hover:text-text-200 transition-colors"
      data-tooltip={copied ? tMsg.copied : tMsg.copyMessage}
      aria-label={tMsg.copyMessage}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function ActionButton({ label, hint, onClick, children }: { label: string; hint?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center text-text-400 hover:text-text-200 transition-colors"
      data-tooltip={label}
      data-tooltip-desc={hint}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function ForkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 12h7" />
      <path d="M11 12l8-8" />
      <path d="M11 12l8 8" />
      <path d="M14 4h5v5" />
      <path d="M19 15v5h-5" />
    </svg>
  );
}

function InlineEditor({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (text: string) => void; onCancel: () => void }) {
  const t = useTranslations().chatUi;
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);
  const submit = () => {
    const text = draft.trim();
    if (text) onSubmit(text);
  };
  return (
    <div className="w-full min-w-[min(36rem,80vw)] rounded-[8px] border border-accent/50 bg-bg-100 p-2 shadow-sm">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        className="w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed text-text-100 outline-none custom-scrollbar"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-text-300 hover:bg-bg-200"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg-0 hover:bg-accent-hover disabled:opacity-50"
        >
          {t.saveAndSend}
        </button>
      </div>
    </div>
  );
}

function MessageBody({
  message,
  leadNotices,
  onOpenView,
  canRevert = false,
  onRevert,
  awaitingPermission = false,
  awaitingAnswer = false,
  compacting,
  retrying,
  canRetry = false,
  canEdit = false,
  canContinue = false,
  onContinue,
  onRetry,
  onEdit,
  onFork,
  canFork = true,
  chatId,
  onReviewChanges,
}: {
  message: ChatMessage;
  leadNotices?: TraceNotice[];
  absorbed?: boolean;
  onOpenView?: (view: string) => void;
  canRevert?: boolean;
  onRevert?: (messageId: string) => void;
  awaitingPermission?: boolean;
  awaitingAnswer?: boolean;
  /** The streaming turn is compacting: Nyxs summarising the chat, or Claude Code its session. */
  compacting?: "summary" | "native";
  /** The streaming turn is waiting to send a failed request again. */
  retrying?: RetryState;
  canRetry?: boolean;
  canEdit?: boolean;
  /** The reply was cut by the app closing and can be continued now (the chat's last, idle). */
  canContinue?: boolean;
  onContinue?: (chatId: string) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
  onFork?: (messageId: string) => void;
  /** The chat can fork now (not while a turn runs). A flag the memo compares, so a reply drawn
   *  while it couldn't gets its button back. */
  canFork?: boolean;
  chatId?: string;
  /** Opens the changes view, at a file when one is given. */
  onReviewChanges?: (path?: string) => void;
}) {
  const isUser = message.role === "user";
  const tUi = useTranslations().chatUi;
  const tMsg = useTranslations().message;
  const [editing, setEditing] = useState(false);
  const { segments, endMap } = useMemo(() => parseMessage(message.content), [message.content]);
  const slashCommand = isUser ? slashCommandOf(message.content) : null;
  const streaming = !!message.streaming;
  const toolData = message.toolData ?? {};
  const todos = message.todos ?? [];

  const reasoningLen = useMemo(
    () => Object.values(message.reasoningData ?? {}).reduce((n, s) => n + s.length, 0),
    [message.reasoningData],
  );
  const activitySig = message.content.length + reasoningLen;
  const sigRef = useRef(activitySig);
  const lastChangeRef = useRef(0);
  const [quiet, setQuiet] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    if (activitySig !== sigRef.current) {
      sigRef.current = activitySig;
      lastChangeRef.current = Date.now();
      setQuiet(false);
    }
  }, [activitySig]);
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (streaming !== wasStreaming) {
    setWasStreaming(streaming);
    setQuiet(false);
  }
  useEffect(() => {
    if (!streaming) return;
    lastChangeRef.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - lastChangeRef.current > 4000) setQuiet(true);
    }, 1000);
    return () => clearInterval(id);
  }, [streaming]);

  const messageTime = message.createdAt ?? message.startedAt ?? null;
  const locale = (typeof localStorage !== "undefined" && localStorage.getItem(LANG_KEY)) || undefined;

  const copyText = useMemo(
    () =>
      segments
        .filter((s) => s.type === "text" || s.type === "code")
        .map((s) => (s.type === "text" || s.type === "code" ? s.content : ""))
        .join("\n")
        .trim(),
    [segments],
  );
  const showRevert = canRevert && !!onRevert;
  const showRetry = canRetry && !!onRetry && !isUser;
  const showEdit = canEdit && !!onEdit && isUser;
  const showFork = !!onFork && canFork && !isUser;
  const showActions = !streaming && !editing && (!!copyText || showRevert || showRetry || showEdit || showFork);
  // While the reply runs a command that can move, its actions row holds just "Run in background",
  // as in Claude Code Desktop (Ctrl+B does the same from anywhere).
  const movable = useHasMovableCommand(streaming && !isUser ? chatId : undefined);
  const tBg = useTranslations().commandBackground;
  const bgKeys = useShortcutLabel("moveToBackground");

  return (
    <div data-message-id={message.id} className={cn("group flex px-4 py-3.5", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex flex-col",
          isUser ? "items-end max-w-[80%]" : "max-w-full min-w-0",
        )}
      >
        {isUser && pickedElementsOf(message).length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {pickedElementsOf(message).map((el, i) => (
              <ElementChip key={`${i}-${el.selector}`} element={el} />
            ))}
          </div>
        )}
        {isUser && message.images && message.images.length > 0 && <MessageImages images={message.images} />}
        {isUser && message.pasted && message.pasted.length > 0 && <MessagePasted pasted={message.pasted} />}
        {isUser && message.documents && message.documents.length > 0 && <MessageDocuments documents={message.documents} />}
        {!isUser && message.reasoning && !message.reasoningData && (
          <ReasoningSummary text={message.reasoning} seconds={null} />
        )}
        {editing && (
          <InlineEditor
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSubmit={(text) => {
              setEditing(false);
              onEdit?.(message.id, text);
            }}
          />
        )}
        {!editing && (!isUser || message.content.trim() || streaming) && (
          <div
            data-message-body
            className={cn(
              isUser
                ? // `anywhere` (unlike `break-word`) shrinks min-content, so a `w-fit` bubble holding one long URL wraps instead of overflowing the column.
                  "w-fit max-w-full rounded-[8px] px-3.5 py-1.5 bg-[color:var(--user-bubble)] text-text-100 [overflow-wrap:anywhere] [&_p]:my-0"
                : // Inherited by lists, headings and quotes; `break-word` keeps table column sizing untouched.
                  "max-w-full min-w-0 text-text-100 break-words",
            )}
          >
            {slashCommand ? (
              <p className="whitespace-pre-wrap break-words">
                <span className="text-text-400">/</span>
                <span className="text-[color:var(--link)]">{slashCommand.name}</span>
                {slashCommand.args && ` ${slashCommand.args}`}
              </p>
            ) : (
              renderSegments(segments, endMap, streaming, toolData, todos, onOpenView, awaitingPermission, message.reasoningData ?? {}, message.reasoningTimes ?? {}, leadNotices, chatId)
            )}
            {streaming && (
              <LiveStatus
                live={{
                  ...withTurnStatus(livePhaseOf(segments, endMap, awaitingPermission, awaitingAnswer, quiet), {
                    compacting,
                    retrying,
                    wake: !!leadNotices?.length,
                  }),
                  startedAt: message.startedAt ?? mountedAt,
                  tokens: message.tokens,
                }}
              />
            )}
          </div>
        )}
        {!isUser && !streaming && message.outputLimit && <OutputLimitNotice hit={message.outputLimit} />}
        {!isUser && !streaming && message.cutOff && (
          <CutOffNotice onContinue={canContinue && chatId && onContinue ? () => onContinue(chatId) : undefined} />
        )}
        {!isUser && !streaming && chatId && message.changedFiles && message.changedFiles.length > 0 && (
          <TurnChanges files={message.changedFiles} toolData={toolData} endMap={endMap} subagentEdits={message.subagentEdits} onReview={onReviewChanges} />
        )}
        {movable && (
          <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={() => moveCommandsToBackground(chatId)}
              className="inline-flex items-center text-text-400 hover:text-text-200 transition-colors"
              data-tooltip={tBg.moveToBackground}
              data-tooltip-kbd={bgKeys}
              aria-keyshortcuts={ariaKeys(bgKeys)}
              aria-label={tBg.moveToBackground}
            >
              <ListTodo className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {showActions && (
          <div
            className={cn(
              "mt-1 flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {copyText && <CopyMessageButton text={copyText} />}
            {showRetry && (
              <ActionButton label={tUi.retry} onClick={() => onRetry!(message.id)}>
                <RotateCcw className="w-3.5 h-3.5" />
              </ActionButton>
            )}
            {showEdit && (
              <ActionButton label={tUi.edit} onClick={() => setEditing(true)}>
                <Pencil className="w-3.5 h-3.5" />
              </ActionButton>
            )}
            {showFork && (
              <ActionButton label={tUi.fork} hint={tUi.forkHint} onClick={() => onFork!(message.id)}>
                <ForkIcon className="w-3.5 h-3.5" />
              </ActionButton>
            )}
            {showRevert && (
              <ActionButton label={tMsg.rewindToHere} hint={tMsg.rewindHint} onClick={() => onRevert!(message.id)}>
                <RotateCcw className="w-3.5 h-3.5" />
              </ActionButton>
            )}
            {!isUser && messageTime != null && (
              <span className="text-[11px] text-text-500" data-tooltip={fullDateTime(messageTime, locale)}>
                {relativeTime(messageTime, locale)}
                {message.tokens ? ` · ${tokensLabel(message.tokens)}` : ""}
              </span>
            )}
            {isUser && messageTime != null && (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-text-500"
                data-tooltip={fullDateTime(messageTime, locale)}
              >
                {relativeTime(messageTime, locale)}
                <CheckCheck className="w-3.5 h-3.5 text-accent" aria-label={tMsg.read} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoticeLine({ notice }: { notice: NonNullable<ChatMessage["notice"]> }) {
  const t = useTranslations().chatUi;
  const tg = useTranslations().goal;
  if (notice.kind === "goal" && notice.goal) {
    const g = notice.goal;
    const text =
      g.state === "met"
        ? g.turns === 1
          ? tg.noticeMetOne
          : tg.noticeMetMany.replace("{count}", String(g.turns))
        : g.state === "limit"
          ? tg.noticeLimit.replace("{count}", String(g.turns)).replace("{reason}", g.reason ?? "")
          : tg.noticeNotMet.replace("{reason}", g.reason ?? "");
    const Icon = g.state === "met" ? CheckCircle2 : Target;
    return (
      <div className="flex justify-center px-4 py-2">
        <span className="flex max-w-[90%] items-center gap-1.5 rounded-[6px] border border-bg-300 bg-bg-100 px-3 py-1 text-[12px] text-text-400" data-tooltip={text}>
          <Icon className={cn("h-3.5 w-3.5 shrink-0", g.state === "met" ? "text-success" : g.state === "limit" ? "text-warning" : "text-accent")} aria-hidden />
          <span className="truncate">{text}</span>
        </span>
      </div>
    );
  }
  if (notice.kind === "resume") {
    return (
      <div className="flex justify-center px-4 py-2">
        <span className="max-w-[90%] truncate rounded-[6px] border border-bg-300 bg-bg-100 px-3 py-1 text-[12px] text-text-400">
          {t.resumedAfterReload}
        </span>
      </div>
    );
  }
  const items = notice.items
    .map((i) => {
      if (i.status === "killed") return `${i.title} · ${t.noticeStopped}`;
      if (i.code != null && i.code !== 0) return `${i.title} · ${t.noticeExitCode.replace("{code}", String(i.code))}`;
      return `${i.title} · ${t.noticeOk}`;
    })
    .join(", ");
  return (
    <div className="flex justify-center px-4 py-2">
      <span className="max-w-[90%] truncate rounded-[6px] border border-bg-300 bg-bg-100 px-3 py-1 text-[12px] text-text-400" data-tooltip={items}>
        {t.backgroundDone}: {items}
      </span>
    </div>
  );
}

function MessageImpl(props: Parameters<typeof MessageBody>[0]) {
  if (props.message.notice) return props.absorbed ? null : <NoticeLine notice={props.message.notice} />;
  if (props.message.fromSession) return <SessionMessageCard from={props.message.fromSession} content={props.message.content} />;
  return <MessageBody {...props} />;
}

export const Message = memo(
  MessageImpl,
  (prev, next) =>
    prev.message === next.message &&
    prev.leadNotices === next.leadNotices &&
    prev.absorbed === next.absorbed &&
    prev.canRevert === next.canRevert &&
    prev.awaitingPermission === next.awaitingPermission &&
    prev.awaitingAnswer === next.awaitingAnswer &&
    prev.compacting === next.compacting &&
    prev.retrying === next.retrying &&
    prev.canRetry === next.canRetry &&
    prev.canEdit === next.canEdit &&
    prev.canContinue === next.canContinue &&
    prev.canFork === next.canFork &&
    prev.chatId === next.chatId,
);

export default Message;

export { MarkdownText };
