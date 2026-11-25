import { Fragment, useMemo, type ComponentProps, type RefObject } from "react";
import { ChatHighlights } from "@/components/ChatHighlights";
import { CompactingDivider, CompactionDivider } from "@/components/CompactionDivider";
import { Message } from "@/components/Message";
import { MessageErrorBoundary } from "@/components/MessageErrorBoundary";
import { MessageQueue } from "@/components/MessageQueue";
import { ScrollToBottom } from "@/components/ScrollToBottom";
import { SelectionReply } from "@/components/SelectionReply";
import { CommandRunContext, type CommandRunEnv } from "@/components/message/commandRun";
import { RemoteClaudeSetup } from "@/components/message/RemoteClaudeSetup";
import { MessageScroller } from "@/components/ui/message-scroller";
import { HIGHLIGHT_SWATCH, turnHighlightColors, type TextHighlight } from "@/lib/chatHighlights";
import { canResendBefore, isMinimapTurn } from "@/lib/chatMessages";
import type { Chat, CompactionMark } from "@/lib/chatStore";
import { useAppearance } from "@/lib/appearance";
import { useTranslations } from "@/lib/i18n";
import type { RetryState } from "@/lib/useStreamingChats";
import { cn } from "@/lib/utils";

interface ChatTranscriptProps {
  chat: Chat;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  zoom: number;
  widthClass: string;
  commandRunEnv: CommandRunEnv;
  /** How many of the latest messages are rendered; older ones wait behind a button. */
  visibleCount: number;
  onShowEarlier: () => void;
  /** A reply is running in this chat. */
  busy: boolean;
  /** Messages whose files can be restored to how they were before them. */
  restorableMsgIds: Set<string>;
  awaitingPermission: boolean;
  awaitingAnswer: boolean;
  /** What the running reply is doing besides streaming. */
  compacting: "summary" | "native" | undefined;
  /** `/compact` is running in this chat outside a reply. */
  compactingChat: boolean;
  retrying: RetryState | undefined;
  /** The machine Claude Code is being made ready on before this turn can start. */
  remoteSetup: string | undefined;
  onCancelRemoteSetup: () => void;
  onOpenView: (view: string) => void;
  onRevert: (messageId: string) => void;
  onRetry: (messageId: string) => void;
  /** Continues a reply the app cut by closing (see ChatMessage.cutOff). */
  onContinue: (chatId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onFork: (messageId: string) => void;
  onReviewChanges: (path?: string) => void;
  queue: ComponentProps<typeof MessageQueue>;
  /** The user jumped to the end: follow new output again. */
  onJumpToEnd: () => void;
  /** Sends a reply about the text the user selected. */
  onReplyToSelection: ComponentProps<typeof SelectionReply>["onReply"];
  onHighlightsChange: (messageId: string, highlights: TextHighlight[]) => void;
}

/** The open chat's conversation: its messages, the queued ones, the minimap, highlights and
 *  the reply-to-selection bubble. */
/** The last messages are always drawn: they're on screen, and they change while a reply streams. */
const LIVE_ROWS = 4;

export function ChatTranscript({
  chat,
  scrollRef,
  onScroll,
  zoom,
  widthClass,
  commandRunEnv,
  visibleCount,
  onShowEarlier,
  busy,
  restorableMsgIds,
  awaitingPermission,
  awaitingAnswer,
  compacting,
  compactingChat,
  retrying,
  remoteSetup,
  onCancelRemoteSetup,
  onOpenView,
  onRevert,
  onRetry,
  onContinue,
  onEdit,
  onFork,
  onReviewChanges,
  queue,
  onJumpToEnd,
  onReplyToSelection,
  onHighlightsChange,
}: ChatTranscriptProps) {
  const tApp = useTranslations().app;
  const dynamic = useAppearance().dynamicConversations;
  const messages = chat.messages;
  // Highlights by message, and the minimap color of each turn that has one.
  const highlights = useMemo(() => {
    const out: Record<string, TextHighlight[]> = {};
    for (const m of messages) if (m.highlights?.length) out[m.id] = m.highlights;
    return out;
  }, [messages]);
  const turnColors = useMemo(() => turnHighlightColors(messages, isMinimapTurn), [messages]);
  const shown = messages.slice(-visibleCount);
  const runEnv = useMemo(() => ({ ...commandRunEnv, chatId: chat.id }), [commandRunEnv, chat.id]);
  const compactionsAfter = useMemo(() => {
    const out = new Map<string, CompactionMark[]>();
    for (const mark of chat.compactions ?? []) out.set(mark.afterId, [...(out.get(mark.afterId) ?? []), mark]);
    return out;
  }, [chat.compactions]);

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* px-8: room for the message minimap on the right (and the same on the left, so the
            text stays centered over the composer) when the window is narrower than the chat. */}
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto custom-scrollbar px-8 py-4" style={{ zoom }}>
          <CommandRunContext.Provider value={runEnv}>
            <div className={cn(widthClass, "mx-auto")}>
              {messages.length > visibleCount && (
                <div className="flex justify-center mb-2">
                  <button
                    onClick={onShowEarlier}
                    className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-bg-300 text-text-300 hover:bg-bg-200"
                  >
                    {tApp.showEarlierMessages.replace("{n}", String(messages.length - visibleCount))}
                  </button>
                </div>
              )}
              {shown.map((m, i) => (
                <Fragment key={m.id}>
                  {/* A message that fails to render shows a notice; the rest of the chat stays. Off
                      screen, an older one isn't drawn (Dynamic conversations, `.chat-row-lazy`). */}
                  <div className={cn(dynamic && !m.streaming && i < shown.length - LIVE_ROWS && "chat-row-lazy")}>
                  <MessageErrorBoundary text={m.content}>
                    <Message
                      message={m}
                      leadNotices={m.role === "assistant" && shown[i - 1]?.notice?.kind === "background" ? shown[i - 1]?.notice?.items : undefined}
                      absorbed={m.notice?.kind === "background" && shown[i + 1]?.role === "assistant"}
                      onOpenView={onOpenView}
                      canRevert={!busy && restorableMsgIds.has(m.id)}
                      onRevert={onRevert}
                      awaitingPermission={awaitingPermission && !!m.streaming}
                      awaitingAnswer={awaitingAnswer && !!m.streaming}
                      compacting={m.streaming ? compacting : undefined}
                      retrying={m.streaming ? retrying : undefined}
                      canRetry={!busy && m.role === "assistant" && i === shown.length - 1 && canResendBefore(shown, i)}
                      canEdit={!busy && m.role === "user" && !m.images?.length && !m.documents?.length && !m.notice}
                      canContinue={!busy && !!m.cutOff && i === shown.length - 1}
                      onRetry={onRetry}
                      onContinue={onContinue}
                      onEdit={onEdit}
                      onFork={onFork}
                      canFork={!busy}
                      chatId={chat.id}
                      onReviewChanges={onReviewChanges}
                    />
                  </MessageErrorBoundary>
                  </div>
                  {compactionsAfter.get(m.id)?.map((mark, j) => <CompactionDivider key={j} mark={mark} />)}
                </Fragment>
              ))}
              {remoteSetup && <RemoteClaudeSetup host={remoteSetup} onCancel={onCancelRemoteSetup} />}
              {compactingChat && !busy && <CompactingDivider />}
              <MessageQueue {...queue} />
            </div>
          </CommandRunContext.Provider>
        </div>
        <MessageScroller
          key={`map-${chat.id}`}
          containerRef={scrollRef}
          messages={shown
            .filter(isMinimapTurn)
            .map((m) => ({
              id: m.id,
              content: m.content.trim(),
              color: turnColors[m.id] ? HIGHLIGHT_SWATCH[turnColors[m.id]] : undefined,
            }))}
          label={tApp.messageMinimap}
          jumpLabel={tApp.jumpToMessage}
        />
      </div>
      <ChatHighlights key={`hl-${chat.id}`} containerRef={scrollRef} highlights={highlights} />
      <ScrollToBottom key={`end-${chat.id}`} containerRef={scrollRef} onJump={onJumpToEnd} label={tApp.scrollToBottom} working={busy} />
      <SelectionReply
        key={chat.id}
        containerRef={scrollRef}
        onReply={onReplyToSelection}
        highlightsOf={(messageId) => highlights[messageId] ?? []}
        onHighlightsChange={onHighlightsChange}
      />
    </>
  );
}
