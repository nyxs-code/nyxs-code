import { useState, type ComponentProps, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import FindBar from "@/components/FindBar";
import { ChatTranscript } from "@/components/ChatTranscript";
import { TurnPrompts } from "@/components/TurnPrompts";
import { ClaudeChatInput } from "@/components/ui/claude-style-chat-input";
import type { Chat } from "@/lib/chatStore";
import type { TextHighlight } from "@/lib/chatHighlights";
import type { TurnSide } from "@/lib/useStreamingChats";
import type { PendingApproval, PendingQuestion } from "@/lib/usePermissionPrompts";
import { messagesToShowFor, useChatScroll } from "@/lib/useChatScroll";
import { useMascotMood } from "@/lib/mascotMood";
import { SESSION_DRAG_TYPE } from "@/lib/useSplitView";
import { useTranslations } from "@/lib/i18n";
import { chatColumnMeasure } from "@/lib/appearance";
import { cn } from "@/lib/utils";

/** What both panes share: the open chat's handlers. The per-chat state comes as ChatPane props. */
type TranscriptProps = Omit<
  ComponentProps<typeof ChatTranscript>,
  | "chat" | "scrollRef" | "onScroll" | "visibleCount" | "onShowEarlier" | "onJumpToEnd"
  | "busy" | "awaitingPermission" | "awaitingAnswer" | "compacting" | "compactingChat" | "retrying" | "remoteSetup" | "onCancelRemoteSetup" | "onHighlightsChange"
>;
type PromptsProps = Omit<ComponentProps<typeof TurnPrompts>, "pending" | "question">;

interface ChatPaneProps {
  chat: Chat;
  /** Two sessions are on screen: the pane shows its header and the focus border. */
  split: boolean;
  /** The pane is the app's open chat: the views panel, Git bar and shortcuts act on it. */
  focused: boolean;
  streaming: boolean;
  /** What the chat's running turn reports besides text (see useStreamingChats). */
  side: TurnSide | undefined;
  /** Nyxs is summarising this chat (`/compact` or auto-compaction mid-turn): a divider in the
   *  conversation, or the reply's live status mid-turn. */
  compacting: boolean;
  pending: PendingApproval[];
  question: PendingQuestion | null;
  onFocus: () => void;
  /** Stops this pane's reply, also while the other pane has focus. */
  onStop: () => void;
  onClose: () => void;
  onHighlightsChange: (chatId: string, messageId: string, highlights: TextHighlight[]) => void;
  findOpen: boolean;
  onCloseFind: () => void;
  transcript: TranscriptProps;
  /** The focused pane's banners. `planReady` means plan mode with no reply running; the pane
   *  adds its own chat's part. */
  prompts: PromptsProps;
  /** The open chat's composer props; the other pane swaps in its own model and state. */
  input: ComponentProps<typeof ClaudeChatInput>;
  topBar: ReactNode;
}

const NO_IDS = new Set<string>();
const NO_QUEUE: never[] = [];

/** The composer of the pane without focus: its own model, effort, context and reply, and none
 *  of the open chat's hooks (refs the views panel fills, files dropped on the window, the
 *  guessed next message). A click makes it the open chat, and then it gets those back. */
function unfocusedInput(input: ComponentProps<typeof ClaudeChatInput>, chat: Chat, streaming: boolean, onStop: () => void): ComponentProps<typeof ClaudeChatInput> {
  const own = chat.model && input.models.some((m) => m.id === chat.model) ? chat.model : input.selectedModel;
  return {
    ...input,
    selectedModel: own,
    isStreaming: streaming,
    onStop,
    contextUsed: chat.contextTokens ?? 0,
    contextTotal: input.models.find((m) => m.id === own)?.context,
    onLoadContextDetails: undefined,
    effort: chat.effort ?? input.effort,
    suggestion: undefined,
    fillRef: undefined,
    attachRef: undefined,
    attachFilesRef: undefined,
    primary: false,
  };
}

/** One session's conversation and composer. Split view mounts two of these side by side; each
 *  keeps its own scroll place. */
export function ChatPane({
  chat, split, focused, streaming, side, compacting, pending, question, onFocus, onStop, onClose, onHighlightsChange,
  findOpen, onCloseFind, transcript, prompts, input, topBar,
}: ChatPaneProps) {
  const t = useTranslations().app;
  const { scrollRef, handleChatScroll, visibleCount, showEarlierMessages, showAtLeast, followOutput } = useChatScroll(chat.id, chat.messages);
  const mascot = useMascotMood({ messages: chat.messages, busy: streaming || compacting, waiting: pending.length > 0 || !!question });
  return (
    <section
      aria-label={chat.title}
      // A click or Tab into the other pane makes it the open chat before the click itself runs,
      // so its buttons act on their own session.
      onPointerDownCapture={focused ? undefined : onFocus}
      onFocusCapture={focused ? undefined : onFocus}
      data-mod-panel={split || undefined}
      className={cn(
        "relative flex-1 flex flex-col min-w-0 min-h-0",
        split && "rounded-[8px] border bg-bg-0 transition-colors",
        split && (focused ? "border-text-500" : "border-bg-300"),
      )}
    >
      {/* Over a theme's backdrop the single view has no panel of its own, so the text sat right on
          the picture: a veil behind the conversation's column keeps it readable (index.css). Split
          panes are already frosted as panels. */}
      {!split && <div aria-hidden className="mod-chat-veil" style={{ "--chat-column": chatColumnMeasure(transcript.widthClass) } as CSSProperties} />}
      {split && (
        <header className="flex items-center gap-2 h-9 px-3 border-b border-bg-300 shrink-0">
          {streaming && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-400" aria-hidden />}
          <span className={cn("flex-1 min-w-0 truncate text-[13px]", focused ? "text-text-100" : "text-text-300")}>{chat.title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.splitClosePane}
            data-tooltip={t.splitClosePane}
            className="shrink-0 p-1 rounded-[6px] text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </header>
      )}
      {findOpen && focused && (
        <div className="flex items-center justify-end px-3 py-1.5">
          <FindBar key={chat.id} containerRef={scrollRef} onClose={onCloseFind} onQuery={(q) => showAtLeast(messagesToShowFor(chat.messages, q))} />
        </div>
      )}
      <ChatTranscript
        {...transcript}
        // File restore and the queue follow the open chat.
        restorableMsgIds={focused ? transcript.restorableMsgIds : NO_IDS}
        queue={focused ? transcript.queue : { ...transcript.queue, items: NO_QUEUE, delivering: NO_QUEUE, paused: false }}
        busy={streaming}
        awaitingPermission={pending.length > 0}
        awaitingAnswer={!!question}
        compacting={side?.compacting ? "native" : compacting ? "summary" : undefined}
        compactingChat={compacting}
        retrying={side?.retrying}
        remoteSetup={side?.remoteSetup}
        onCancelRemoteSetup={onStop}
        onHighlightsChange={(messageId, next) => onHighlightsChange(chat.id, messageId, next)}
        chat={chat}
        scrollRef={scrollRef}
        onScroll={handleChatScroll}
        visibleCount={visibleCount}
        onShowEarlier={showEarlierMessages}
        onJumpToEnd={followOutput}
      />
      {/* Only the focused pane: the prompts' handlers act on the open chat. */}
      {focused && (
        <TurnPrompts
          {...prompts}
          planReady={prompts.planReady && chat.messages.some((m) => m.role === "assistant" && m.content.includes("⟦PLAN⟧"))}
          pending={pending}
          question={question}
        />
      )}
      <div className="px-4 pb-2 pt-2">
        <ClaudeChatInput
          {...(focused ? input : unfocusedInput(input, chat, streaming || compacting, onStop))}
          topBar={topBar}
          draftKey={chat.id}
          lockWorkspace={chat.messages.length > 0}
          mascot={mascot}
        />
      </div>
    </section>
  );
}

/** The chat area while a sidebar session is dragged over it: dropping opens that session next
 *  to the open one. */
export function SessionDropZone({ enabled, onOpenSession, children }: { enabled: boolean; onOpenSession: (id: string) => void; children: ReactNode }) {
  const t = useTranslations().app;
  const [over, setOver] = useState(false);
  const carriesSession = (e: DragEvent) => enabled && e.dataTransfer.types.includes(SESSION_DRAG_TYPE);
  return (
    <div
      className="relative flex-1 flex min-h-0 min-w-0"
      onDragOver={(e) => {
        if (!carriesSession(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        if (!carriesSession(e)) return;
        e.preventDefault();
        const id = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        if (id) onOpenSession(id);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-y-2 right-2 w-1/2 rounded-[8px] border-2 border-dashed border-accent/60 bg-accent/5 flex items-center justify-center">
          <span className="text-sm text-text-200">{t.splitDropHint}</span>
        </div>
      )}
    </div>
  );
}
