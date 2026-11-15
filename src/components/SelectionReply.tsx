import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CornerDownLeft, Eraser, Plus, Reply } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { quoteForReply } from "@/lib/replyQuote";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_SWATCH,
  bodyOf,
  lastHighlightColor,
  newHighlight,
  overlapping,
  rememberHighlightColor,
  spotOfRange,
  type HighlightColor,
  type SelectionSpot,
  type TextHighlight,
} from "@/lib/chatHighlights";
import { isComposingKey } from "@/lib/imeKeys";
import { useVoiceInput, type VoiceSend } from "@/components/ui/chat-input/useVoiceInput";
import { MicButton, VoiceWaveform } from "@/components/ui/chat-input/VoiceControls";
import { useComposerAttachments } from "@/components/ui/chat-input/useComposerAttachments";
import { ComposerAttachments } from "@/components/ui/chat-input/Attachments";
import type { AttachedFile, PastedSnippet } from "@/components/ui/chat-input/types";
import { releasePreviews } from "@/lib/attachmentPreviews";
import { addPickedElement, type PickedElement } from "@/lib/pickedElement";
import { setReplyAttachTarget } from "@/lib/replyAttachTarget";

const MARGIN = 8;
const POPOVER_WIDTH = 340;
/** Room the color menu needs above the toolbar before it opens downward instead. */
const COLOR_MENU_HEIGHT = 230;

interface Anchor {
  x: number;
  top: number;
  bottom: number;
}

interface Picked {
  text: string;
  anchor: Anchor;
  /** Where it sits in one message, when it does: only then can it be highlighted. */
  spot: SelectionSpot | null;
}

function selectionIn(container: HTMLElement | null): Picked | null {
  const sel = window.getSelection();
  if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (el?.closest("textarea, input, [contenteditable='true']")) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, anchor: { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }, spot: spotOfRange(range) };
}

export function SelectionReply({
  containerRef,
  onReply,
  highlightsOf,
  onHighlightsChange,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onReply: (message: string, attachments: { files: AttachedFile[]; pastedContent: PastedSnippet[]; elements: PickedElement[] }) => void;
  /** The highlights a message has now. Without it there is no color picker. */
  highlightsOf?: (messageId: string) => TextHighlight[];
  onHighlightsChange?: (messageId: string, next: TextHighlight[]) => void;
}) {
  const translations = useTranslations();
  const t = translations.chatUi;
  const tInput = translations.chatInput;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [colorMenu, setColorMenu] = useState(false);
  const [lastColor, setLastColor] = useState<HighlightColor>(lastHighlightColor);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [popoverTop, setPopoverTop] = useState(0);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedSnippet[]>([]);
  const [elements, setElements] = useState<PickedElement[]>([]);
  const pickedRef = useRef(picked);
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  const filesRef = useRef(files);
  useEffect(() => { filesRef.current = files; }, [files]);

  // Same file picker and paste as the main input. Not `primary`: a file dropped on the window
  // still goes to the main input.
  const { fileInputRef, focusComposer, pickFiles, handleFiles, handlePaste } = useComposerAttachments({
    textareaRef: inputRef,
    setFiles,
    setPastedContent,
    primary: false,
  });

  /** Sends the reply with what's attached. Empty text with an attachment is allowed, like the main input. */
  const deliver = (text: string) => {
    const quote = pickedRef.current?.text;
    if (!quote || (!text.trim() && files.length === 0 && pastedContent.length === 0 && elements.length === 0)) return;
    onReply(quoteForReply(quote, text), { files, pastedContent, elements });
    // The sent message owns the thumbnails now: don't free them on close.
    filesRef.current = [];
    window.getSelection()?.removeAllRanges();
    close();
  };

  // Same dictation as the main chat input. A transcript that lands after the box closed is dropped.
  const voice = useVoiceInput({
    textareaRef: inputRef,
    onTranscript: (text: string, send: VoiceSend) => {
      if (!replyingRef.current) return;
      const next = text ? draft + (draft && !/\s$/.test(draft) ? " " : "") + text : draft;
      if (send) {
        deliver(next);
        return;
      }
      setDraft(next);
      inputRef.current?.focus();
    },
  });
  const { voiceState, cancelVoice, stopVoice, getVoiceLevel } = voice;

  const close = useCallback(() => {
    cancelVoice();
    releasePreviews(filesRef.current);
    filesRef.current = [];
    setFiles([]);
    setPastedContent([]);
    setElements([]);
    setPicked(null);
    setReplying(false);
    setDraft("");
    setColorMenu(false);
  }, [cancelVoice]);

  const replyingRef = useRef(replying);
  useEffect(() => { replyingRef.current = replying; }, [replying]);

  useEffect(() => {
    if (!replying) return;
    return setReplyAttachTarget({
      element: (el) => {
        setElements((prev) => addPickedElement(prev, el));
        inputRef.current?.focus();
      },
      files: (list) => {
        handleFiles(list);
        inputRef.current?.focus();
      },
    });
  }, [replying, handleFiles]);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!toolbarRef.current?.contains(target) || !!popoverRef.current?.contains(target));
    const read = (e?: Event) => {
      if (inside(e?.target ?? null)) return;
      window.setTimeout(() => {
        if (replyingRef.current) return;
        setPicked(selectionIn(containerRef.current));
        setColorMenu(false);
      }, 0);
    };
    // While replying, the side panel (the browser, to pick an element for the reply) can be used
    // without losing the reply: only the chat area closes it.
    const outsideChat = (target: EventTarget | null) =>
      target instanceof Element && !target.closest("[data-side-chat-area]");
    const onDown = (e: MouseEvent) => {
      if (inside(e.target)) return;
      if (replyingRef.current) {
        if (!outsideChat(e.target)) close();
      } else {
        setPicked(null);
        setColorMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (picked || replyingRef.current)) {
        if (replyingRef.current && !inside(e.target) && outsideChat(e.target)) return;
        close();
      }
      else if (!replyingRef.current && (e.shiftKey || e.key.startsWith("Arrow"))) read(e);
    };
    document.addEventListener("mouseup", read);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keyup", onKey);
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keyup", onKey);
    };
  }, [containerRef, picked, close]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !picked) return;
    const onScroll = () => {
      if (replying) return;
      setPicked(selectionIn(el));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [containerRef, picked, replying]);

  useLayoutEffect(() => {
    if (!replying || !picked) return;
    const h = popoverRef.current?.offsetHeight ?? 0;
    const below = picked.anchor.bottom + MARGIN;
    setPopoverTop(below + h + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, picked.anchor.top - h - MARGIN));
    inputRef.current?.focus();
  }, [replying, picked, files.length, pastedContent.length, elements.length]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft, replying]);

  if (!picked) return null;

  const left = Math.min(Math.max(MARGIN, picked.anchor.x), window.innerWidth - MARGIN);
  const send = () => {
    if (voiceState === "recording") { void stopVoice("send"); return; }
    deliver(draft);
  };
  const hasContent = Boolean(draft.trim() || files.length > 0 || pastedContent.length > 0 || elements.length > 0);

  const spot = picked.spot;
  const canHighlight = !!spot && !!highlightsOf && !!onHighlightsChange;
  const bodyText = () => (spot ? bodyOf(document, spot.messageId)?.textContent ?? "" : "");
  const overlaps = canHighlight ? overlapping(bodyText(), highlightsOf(spot.messageId), spot.start, spot.end) : [];

  /** Highlights the selection in `color`, or clears what it covers with null. A new highlight
   *  replaces the ones it overlaps, so a passage never carries two colors. */
  const highlight = (color: HighlightColor | null) => {
    if (!spot || !highlightsOf || !onHighlightsChange) return;
    const gone = new Set(overlaps.map((h) => h.id));
    const kept = highlightsOf(spot.messageId).filter((h) => !gone.has(h.id));
    const next = color ? [...kept, newHighlight(spot, color)] : kept;
    onHighlightsChange(spot.messageId, next);
    if (color) {
      rememberHighlightColor(color);
      setLastColor(color);
    }
    window.getSelection()?.removeAllRanges();
    close();
  };

  if (!replying) {
    const toolbarTop = Math.max(MARGIN, picked.anchor.top - 6);
    // The toolbar sits above the selection; its menu opens further up unless that runs off screen.
    const menuBelow = toolbarTop < COLOR_MENU_HEIGHT;
    const menuRow = "flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-text-100 transition-colors hover:bg-bg-200";
    return createPortal(
      <div
        ref={toolbarRef}
        className="fixed z-50 -translate-x-1/2 -translate-y-full animate-fade-in"
        style={{ left, top: toolbarTop }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="relative flex items-center gap-0.5 rounded-[8px] border border-bg-300 bg-bg-100 p-0.5 shadow-lg">
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[13px] text-text-100 transition-colors hover:bg-bg-200"
          >
            <Reply className="h-3.5 w-3.5 text-text-300" />
            {t.reply}
          </button>
          {canHighlight && (
            <>
              <span className="mx-0.5 h-4 w-px shrink-0 bg-bg-300" aria-hidden />
              <button
                type="button"
                aria-label={t.highlight}
                aria-haspopup="menu"
                aria-expanded={colorMenu}
                data-tooltip={colorMenu ? undefined : t.highlight}
                onClick={() => setColorMenu((o) => !o)}
                className={`inline-flex h-7 items-center gap-0.5 rounded-[6px] px-1.5 text-text-200 transition-colors hover:bg-bg-200 ${colorMenu ? "bg-bg-200" : ""}`}
              >
                <span className="h-3.5 w-3.5 rounded-full border border-black/15" style={{ background: HIGHLIGHT_SWATCH[lastColor] }} />
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {colorMenu && (
                <div
                  role="menu"
                  className={`absolute right-0 z-50 w-40 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg ${menuBelow ? "top-full mt-2" : "bottom-full mb-2"}`}
                >
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="menuitemradio"
                      aria-checked={c === lastColor}
                      aria-label={t.highlightColors[c]}
                      className={menuRow}
                      onClick={() => highlight(c)}
                    >
                      <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/20" style={{ background: HIGHLIGHT_SWATCH[c] }} />
                      <span className="flex-1 text-text-200">{t.highlightColors[c]}</span>
                      {c === lastColor && <Check className="h-3.5 w-3.5 text-sky-600 dark:text-sky-300" />}
                    </button>
                  ))}
                  {overlaps.length > 0 && (
                    <>
                      <div className="my-1 h-px bg-bg-300" aria-hidden />
                      <button type="button" role="menuitem" className={menuRow} onClick={() => highlight(null)}>
                        <Eraser className="h-3.5 w-3.5 shrink-0 text-text-300" />
                        <span className="flex-1 text-text-200">{t.removeHighlight}</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  const popoverLeft = Math.min(Math.max(MARGIN, left - POPOVER_WIDTH / 2), window.innerWidth - POPOVER_WIDTH - MARGIN);
  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t.reply}
      className="fixed z-50 rounded-[8px] border border-bg-300 bg-bg-100 p-2 shadow-lg animate-fade-in"
      style={{ left: Math.max(MARGIN, popoverLeft), top: popoverTop, width: Math.min(POPOVER_WIDTH, window.innerWidth - MARGIN * 2) }}
    >
      <p className="mb-1.5 border-l-2 border-bg-300 pl-2 text-[12.5px] leading-snug text-text-300 line-clamp-3 whitespace-pre-wrap break-words">
        {picked.text}
      </p>
      <ComposerAttachments
        attachedElements={elements}
        setAttachedElements={setElements}
        files={files}
        setFiles={setFiles}
        pastedContent={pastedContent}
        setPastedContent={setPastedContent}
      />
      <div className="flex items-end gap-1.5">
        <button
          type="button"
          onClick={pickFiles}
          aria-label={tInput.attachFile}
          className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-text-400 hover:text-text-200 hover:bg-bg-200 active:scale-95 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={voiceState === "recording" ? tInput.voiceRecording : t.replyPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className={`min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[14px] leading-relaxed text-text-100 placeholder:text-text-500 ${voiceState === "recording" ? "placeholder:italic" : ""} outline-none custom-scrollbar`}
        />
        {voiceState === "recording" && <VoiceWaveform getLevel={getVoiceLevel} />}
        {(hasContent || voiceState === "recording") && (
          <button
            type="button"
            onClick={send}
            aria-label={t.saveAndSend}
            className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-text-300 hover:text-text-100 hover:bg-bg-200 active:scale-95 transition-colors animate-fade-in"
          >
            <CornerDownLeft className="w-4 h-4" />
          </button>
        )}
        <MicButton voice={voice} />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
          void focusComposer();
        }}
      />
    </div>,
    document.body,
  );
}
