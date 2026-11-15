import { useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, MessageCircleQuestion, Minimize2, PanelRight, PictureInPicture2, X } from "lucide-react";
import { Message, type ChatMessage } from "@/components/Message";
import { ScrollToBottom } from "@/components/ScrollToBottom";
import { ClaudeChatInput } from "@/components/ui/claude-style-chat-input";
import { useChatScroll } from "@/lib/useChatScroll";
import { useTranslations } from "@/lib/i18n";
import type { Settings } from "@/lib/settings";
import {
  askSideQuestion,
  closeSideChat,
  dockSideChat,
  hasSideSession,
  minimizeSideChat,
  nearestCorner,
  setSideAbort,
  setSideCorner,
  setSideModel,
  setSideTurns,
  sideContext,
  sideKey,
  sideSessionOf,
  stopSideAnswer,
  takePendingQuestion,
  useSideChat,
  type SideCorner,
} from "@/lib/sideChat";
import { cn } from "@/lib/utils";

const clean = (s: string) => s.replace(/⟦(TOOL|TOOLEND|REASONING)⟧[\s\S]*?(⟦\/\1⟧|$)|⟦(?:TODO|PLAN)⟧/g, "");

/** The main composer's props the side chat shares: the models and where to manage them. */
export type SideChatInputBase = Pick<ComponentProps<typeof ClaudeChatInput>, "models" | "onOpenSettings" | "onManageModels" | "workspace" | "widthClass">;

interface SideChatProps {
  chatId: string | null;
  /** The session's conversation, which the side chat reads. */
  messages: { role: string; content: string }[];
  /** The session's model; the side chat's composer can pick another one for itself. */
  modelId: string;
  settings: Settings;
  input: SideChatInputBase;
}

/** One session's side chat: its conversation, drawn like the main chat's, and the main chat's
 *  composer. Mounted in the side panel or in the minimized card. */
function SideChatBody({ chatId, messages, modelId, settings, input }: SideChatProps) {
  const t = useTranslations().sideChat;
  const tApp = useTranslations().app;
  const key = sideKey(chatId);
  useSideChat();
  const session = sideSessionOf(key);
  const model = session.model && input.models.some((m) => m.id === session.model) ? session.model : modelId;
  const shown: ChatMessage[] = useMemo(
    () =>
      session.turns.map((turn, i) => ({
        id: `side-${key}-${i}`,
        role: turn.role,
        content: turn.content,
        streaming: session.busy && turn.role === "assistant" && i === session.turns.length - 1,
      })),
    [session.turns, session.busy, key],
  );
  // The main chat's scrolling: it follows the answer while the user is at the end, and leaves
  // them where they scrolled up to read.
  const { scrollRef, handleChatScroll, followOutput } = useChatScroll(key, shown);
  const ctxRef = useRef({ messages, model, settings });
  useEffect(() => { ctxRef.current = { messages, model, settings }; });

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || sideSessionOf(key).busy) return;
    // Asking takes the user to the answer, as sending does in the main chat.
    followOutput();
    const asked = [...sideSessionOf(key).turns, { role: "user" as const, content: q }];
    setSideTurns(key, [...asked, { role: "assistant", content: "" }], true);
    const ctrl = new AbortController();
    setSideAbort(key, ctrl);
    let answer = "";
    try {
      const { messages: m, model: id, settings: s } = ctxRef.current;
      const ok = await askSideQuestion({
        modelId: id,
        settings: s,
        context: sideContext(m),
        turns: asked,
        signal: ctrl.signal,
        onDelta: (d) => {
          if (ctrl.signal.aborted) return;
          answer += d;
          setSideTurns(key, [...asked, { role: "assistant", content: clean(answer) }], true);
        },
      });
      if (!ok) answer = t.unsupported;
    } catch (e) {
      if (!ctrl.signal.aborted) answer = `${t.failed} ${e instanceof Error ? e.message : String(e)}`;
    }
    setSideAbort(key, null);
    // Closed meanwhile: its conversation is gone, and this mustn't bring it back. Stopped, what
    // was written stays.
    if (ctrl.signal.aborted && !hasSideSession(key)) return;
    setSideTurns(key, [...asked, { role: "assistant", content: clean(answer).trim() || t.noAnswer }], false);
  };
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; });

  // A question that came with /btw is sent once the side chat is on screen.
  useEffect(() => {
    const q = takePendingQuestion();
    if (q) void askRef.current(q);
  }, []);

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={handleChatScroll} className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-3">
          {/* One element always: useChatScroll watches the first child's size to follow the answer. */}
          <div className="flex min-h-full flex-col">
            {shown.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="text-[13px] text-text-400">{t.hint}</p>
              </div>
            ) : (
              shown.map((m) => <Message key={m.id} message={m} canFork={false} />)
            )}
          </div>
        </div>
        <ScrollToBottom containerRef={scrollRef} onJump={followOutput} label={tApp.scrollToBottom} working={session.busy} />
      </div>
      <div className="shrink-0 px-2 pb-2 pt-1">
        <ClaudeChatInput
          {...input}
          widthClass="max-w-none"
          selectedModel={model}
          onModelChange={(id) => setSideModel(key, id)}
          onSendMessage={(p) => { void ask(p.message); }}
          isStreaming={session.busy}
          onStop={() => stopSideAnswer(key)}
          placeholder={t.placeholder}
          effortLevels={null}
          lockWorkspace
          draftKey={`side:${key}`}
          primary={false}
          sideChat
        />
      </div>
    </>
  );
}

const headerButton = "p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200";

/** The side chat as a view of the session's panel: minimize, maximize and close. */
export function SideChatPane(props: SideChatProps & { onToggleMaximize: () => void; maximized: boolean }) {
  const t = useTranslations().sideChat;
  const tViews = useTranslations().views;
  const { onToggleMaximize, maximized, ...body } = props;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestion className="h-4 w-4 shrink-0 text-text-300" />
          <span className="truncate text-[13px] font-medium text-text-100">{t.title}</span>
          <span className="truncate text-[12px] text-text-400">{t.notSaved}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={minimizeSideChat} aria-label={t.minimize} data-tooltip={t.minimize} className={headerButton}>
            <PictureInPicture2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={onToggleMaximize} aria-label={maximized ? tViews.showChat : tViews.diffExpandPanel} className={headerButton}>
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button type="button" onClick={closeSideChat} aria-label={t.close} className={headerButton}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <SideChatBody {...body} />
    </div>
  );
}

const MARGIN = 12;

interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the card may sit: the chat's area (App marks it), between the sidebar and the side
 *  panel, so it never covers either. The whole window when the chat is hidden. */
function useChatArea(): Area {
  const measure = (): Area => {
    const el = document.querySelector("[data-side-chat-area]");
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0) return { left: 0, top: 36, right: window.innerWidth, bottom: window.innerHeight };
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const [area, setArea] = useState<Area>(measure);
  useEffect(() => {
    const update = () => setArea((prev) => {
      const next = measure();
      return prev.left === next.left && prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom ? prev : next;
    });
    update();
    const el = document.querySelector("[data-side-chat-area]");
    // The sidebar or the side panel opening, closing or being resized moves the chat's edges.
    const ro = el ? new ResizeObserver(update) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return area;
}

const cornerStyle = (corner: SideCorner, a: Area) => ({
  ...(corner.startsWith("top") ? { top: a.top + MARGIN } : { bottom: window.innerHeight - a.bottom + MARGIN }),
  ...(corner.endsWith("left") ? { left: a.left + MARGIN } : { right: window.innerWidth - a.right + MARGIN }),
});

/** The minimized side chat: a card in a corner of the chat's area. Dragged by its header, it
 *  goes to the corner nearest to where it's let go. */
export function SideChatCard(props: SideChatProps) {
  const t = useTranslations().sideChat;
  const { corner } = useSideChat();
  const area = useChatArea();
  const cardRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    const box = cardRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    // Kept inside the chat's area while dragged too.
    const at = (ev: PointerEvent) => ({
      x: Math.min(Math.max(ev.clientX - dx, area.left), Math.max(area.left, area.right - box.width)),
      y: Math.min(Math.max(ev.clientY - dy, area.top), Math.max(area.top, area.bottom - box.height)),
    });
    const move = (ev: PointerEvent) => setDrag(at(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = at(ev);
      setSideCorner(nearestCorner(p.x + box.width / 2 - area.left, p.y + box.height / 2 - area.top, area.right - area.left, area.bottom - area.top));
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setDrag({ x: box.left, y: box.top });
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t.title}
      data-webview-hole
      style={{
        ...(drag ? { left: drag.x, top: drag.y } : cornerStyle(corner, area)),
        // Never wider or taller than the chat's area.
        width: Math.min(380, area.right - area.left - 2 * MARGIN),
        height: Math.min(560, area.bottom - area.top - 2 * MARGIN),
      }}
      className={cn(
        "fixed z-[70] flex flex-col rounded-[8px] border border-bg-300 bg-bg-100 shadow-xl",
        drag && "select-none",
      )}
    >
      <div onPointerDown={startDrag} className={cn("flex items-center justify-between px-3 py-2", drag ? "cursor-grabbing" : "cursor-grab")}>
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestion className="h-4 w-4 shrink-0 text-text-300" />
          <span className="truncate text-[13px] font-medium text-text-100">{t.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={dockSideChat} aria-label={t.dock} data-tooltip={t.dock} className={headerButton}>
            <PanelRight className="h-4 w-4" />
          </button>
          <button type="button" onClick={closeSideChat} aria-label={t.close} className={headerButton}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <SideChatBody {...props} />
    </div>
  );
}
