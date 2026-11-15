import React, { useCallback, useState, useRef, useEffect } from "react";
import type { SlashCommand } from "@/lib/slashCommand";
import { NyxsMascot } from "@/components/NyxsMascot";
import type { MascotMood } from "@/lib/mascotMood";
import { addPickedElement, type PickedElement } from "@/lib/pickedElement";
import { ElementChip } from "@/components/ui/element-chip";
import { useTranslations } from "@/lib/i18n";
import { EFFORT_LEVELS, type EffortLevel } from "@/lib/effort";
import { previewSuggestion } from "@/lib/promptSuggestion";
import type { ContextBreakdown, PlanUsage } from "@/lib/claudeCode";
import { Icons } from "./chat-input/icons";
import type { Model, PermissionMode, SendPayload, SessionUsage } from "./chat-input/types";
import { ComposerAttachments } from "./chat-input/Attachments";
import { ModelSelector } from "./chat-input/ModelSelector";
import { ContextMeter } from "./chat-input/ContextMeter";
import { PermissionSelector } from "./chat-input/PermissionSelector";
import { LockedMachineChip, WorkspaceChips } from "./chat-input/WorkspaceChips";
import { SlashMenu, MentionMenu } from "./chat-input/SuggestionMenus";
import { VoiceWaveform, MicButton } from "./chat-input/VoiceControls";
import { useInputDraft } from "./chat-input/useInputDraft";
import { useComposerSuggestions } from "./chat-input/useComposerSuggestions";
import { useComposerAttachments } from "./chat-input/useComposerAttachments";
import { useVoiceInput, type VoiceSend } from "./chat-input/useVoiceInput";
import { livePreview } from "@/lib/attachmentPreviews";
import { isComposingKey } from "@/lib/imeKeys";


export type { PickedElement } from "@/lib/pickedElement";
export type { AttachedFile, PastedSnippet, Model, PermissionMode, SendPayload, SessionUsage } from "./chat-input/types";
export { ModelLogo } from "./chat-input/ModelLogo";

export { ElementChip };

interface ClaudeChatInputProps {
    widthClass?: string;
    models: Model[];
    selectedModel: string;
    onModelChange: (modelId: string) => void;
    /** Sends the message; a rejected promise puts it back in the box (it wasn't sent). */
    onSendMessage: (data: SendPayload) => void | Promise<void>;
    onOpenSettings?: () => void;
    onManageModels?: () => void;
    isStreaming?: boolean;
    onStop?: () => void;
    onSteer?: (payload: SendPayload) => void;
    onQueue?: (payload: SendPayload) => void;
    placeholder?: string;
    /** A guessed next message, shown in the empty box; Tab writes it in. */
    suggestion?: string;
    contextUsed?: number;
    contextTotal?: number;
    /** Breakdown of the context window, when the provider can measure it. */
    onLoadContextDetails?: () => Promise<ContextBreakdown | null>;
    /** Plan usage limits, when the provider reports them (Claude Code). */
    onLoadPlanUsage?: () => Promise<PlanUsage | null>;
    cachedPlanUsage?: () => PlanUsage | null;
    sessionUsage?: SessionUsage | null;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    allowPermissionBypass?: boolean;
    effort?: EffortLevel;
    onEffortChange?: (effort: EffortLevel) => void;
    /** The levels the selected model offers; null hides the selector (no effort setting). */
    effortLevels?: EffortLevel[] | null;
    /** The level marked "Recommended"; none when it isn't known. */
    recommendedEffort?: EffortLevel;
    workspace?: string | null;
    onPickWorkspace?: () => void;
    lockWorkspace?: boolean;
    recentWorkspaces?: string[];
    onSelectWorkspace?: (path: string) => void;
    onCloseWorkspace?: (path: string) => void;
    onListFiles?: () => Promise<string[]>;
    commands?: SlashCommand[];
    /** Fills the box: with text, or with a whole message the app didn't send (attachments too). */
    fillRef?: React.RefObject<((value: string | SendPayload) => void) | null>;
    attachRef?: React.RefObject<((el: PickedElement) => void) | null>;
    /** Lets others attach files, e.g. the browser's annotated screenshot. */
    attachFilesRef?: React.RefObject<((files: File[]) => void) | null>;
    /** The mascot on the composer's edge and its mood (see useMascotMood); none without it. */
    mascot?: MascotMood;
    /** A strip tucked behind the composer's top edge, e.g. the branch and its changes. */
    topBar?: React.ReactNode;
    /** Which session the composer is writing in: each one keeps its own unsent draft. */
    draftKey?: string;
    /** The composer that takes app-wide input: files dropped on the window and "Attach as
     *  context". Off for the unfocused pane of a split view, so it doesn't land in both. */
    primary?: boolean;
    /** The side chat's composer: the same box, without what it can't use (it reads text only and
     *  runs no tools): attachments, the permission mode and the context meter. */
    sideChat?: boolean;
}

export const ClaudeChatInput: React.FC<ClaudeChatInputProps> = ({
    widthClass = "max-w-6xl",
    models,
    selectedModel,
    onModelChange,
    onSendMessage,
    onOpenSettings,
    onManageModels,
    isStreaming = false,
    onStop,
    onSteer,
    onQueue,
    placeholder,
    suggestion,
    contextUsed = 0,
    contextTotal = 200_000,
    onLoadContextDetails,
    onLoadPlanUsage,
    cachedPlanUsage,
    sessionUsage,
    permissionMode = "skip",
    onPermissionModeChange,
    allowPermissionBypass = false,
    effort = "medium",
    onEffortChange,
    effortLevels = EFFORT_LEVELS,
    recommendedEffort,
    workspace,
    onPickWorkspace,
    lockWorkspace = false,
    recentWorkspaces = [],
    onSelectWorkspace,
    onCloseWorkspace,
    onListFiles,
    commands = [],
    fillRef,
    attachRef,
    attachFilesRef,
    mascot,
    topBar,
    draftKey = "",
    primary = true,
    sideChat = false,
}) => {
    const t = useTranslations().chatInput;
    const { message, setMessage, files, setFiles, pastedContent, setPastedContent, attachedElements, setAttachedElements } = useInputDraft(draftKey);
    const [isThinkingEnabled] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const pendingCursorRef = useRef<number | null>(null);

    const {
        mentionOpen, setMentionOpen, mentionItems, mentionIndex, setMentionIndex, selectMention,
        slashOpen, setSlashOpen, slashItems, slashIndex, setSlashIndex, slashHovering, setSlashHovering, selectSlash,
        refreshSuggestions, handleMenuKey,
    } = useComposerSuggestions({ textareaRef, setMessage, pendingCursorRef, workspace, onListFiles, commands, primary });

    /** Puts a message back in the box as it was: its text, files, pasted text and picked elements. */
    const restore = useCallback((value: string | SendPayload) => {
        const payload = typeof value === "string" ? null : value;
        const text = payload ? payload.message : (value as string);
        setMessage(text);
        if (payload) {
            // A thumbnail freed once the message seemed to be on its way is drawn again.
            setFiles(payload.files.map(livePreview));
            setPastedContent(payload.pastedContent);
            setAttachedElements(payload.elements ?? []);
        }
        pendingCursorRef.current = text.length;
    }, [setMessage, setFiles, setPastedContent, setAttachedElements]);

    useEffect(() => {
        if (!fillRef) return;
        fillRef.current = restore;
        return () => { fillRef.current = null; };
    }, [fillRef, restore]);

    /** Sends now, and gets the message back in the box if sending throws or rejects: the
     *  restore lands after the box was cleared for the send. */
    const sendNow = (payload: SendPayload) => {
        void new Promise<void>((resolve) => resolve(onSendMessage(payload))).catch(() => restore(payload));
    };

    useEffect(() => {
        if (!attachRef) return;
        attachRef.current = (el: PickedElement) => {
            setAttachedElements((prev) => addPickedElement(prev, el));
            textareaRef.current?.focus();
        };
        return () => { attachRef.current = null; };
    }, [attachRef, setAttachedElements]);

    useEffect(() => {
        if (pendingCursorRef.current == null) return;
        const pos = pendingCursorRef.current;
        pendingCursorRef.current = null;
        const ta = textareaRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(pos, pos); }
    }, [message]);

    useEffect(() => {
        if (textareaRef.current) {
            const ta = textareaRef.current;
            const max = 19 * 18;
            ta.style.height = "auto";
            ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
            ta.style.height = Math.min(ta.scrollHeight, max) + "px";
        }
    }, [message]);

    const { isDragging, fileInputRef, focusComposer, pickFiles, handleFiles, handlePaste } = useComposerAttachments({ textareaRef, setFiles, setPastedContent, attachFilesRef, primary });

    const clearAfterSend = () => {
        setMessage("");
        setFiles([]);
        setPastedContent([]);
        setAttachedElements([]);
        setMentionOpen(false);
        setSlashOpen(false);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
    };

    const appendTranscript = (text: string) => {
        if (!text) return;
        setMessage((prev) => {
            const sep = prev && !/\s$/.test(prev) ? " " : "";
            const next = prev + sep + text;
            pendingCursorRef.current = next.length;
            return next;
        });
        textareaRef.current?.focus();
    };

    // Transcribing takes a moment and the turn may end meanwhile: whether the draft is queued
    // or sent is decided when the transcript arrives, not when Enter was pressed.
    const streamingRef = useRef(isStreaming);
    useEffect(() => { streamingRef.current = isStreaming; }, [isStreaming]);

    // Live dictation writes into the draft as the words come: `base` is the draft before them,
    // `shown` what the box held after the last update. If the user types over it (the box no
    // longer holds `shown`), dictation stops touching the box.
    const liveRef = useRef<{ base: string; shown: string; off: boolean } | null>(null);
    const messageRef = useRef(message);
    useEffect(() => { messageRef.current = message; }, [message]);
    const joinDraft = (base: string, text: string) => (text ? base + (base && !/\s$/.test(base) ? " " : "") + text : base);

    const handleLiveText = (text: string) => {
        const current = messageRef.current;
        const live = liveRef.current ?? (liveRef.current = { base: current, shown: current, off: false });
        if (live.off) return;
        if (current !== live.shown) { live.off = true; return; }
        const next = joinDraft(live.base, text);
        live.shown = next;
        messageRef.current = next;
        pendingCursorRef.current = next.length;
        setMessage(next);
    };

    // `send` (Enter while listening) sends the draft plus the transcript once it arrives.
    const handleTranscript = (text: string, send: VoiceSend) => {
        const live = liveRef.current;
        liveRef.current = null;
        // The final transcript replaces the live words; text the user typed over them stays as is.
        if (live?.off) text = "";
        const base = live && !live.off ? live.base : messageRef.current;
        if (!send) {
            if (!live) { appendTranscript(text); return; }
            const next = joinDraft(base, text);
            messageRef.current = next;
            pendingCursorRef.current = next.length;
            setMessage(next);
            textareaRef.current?.focus();
            return;
        }
        const draft = joinDraft(base, text);
        if (!draft.trim() && files.length === 0 && pastedContent.length === 0 && attachedElements.length === 0) return;
        const payload = { message: draft, files, pastedContent, model: selectedModel, isThinkingEnabled, elements: attachedElements.length ? attachedElements : undefined };
        if (!streamingRef.current) sendNow(payload);
        else if (onSteer && (send === "steer" || !onQueue)) onSteer(payload);
        else if (onQueue) onQueue(payload);
        else {
            messageRef.current = draft;
            pendingCursorRef.current = draft.length;
            setMessage(draft);
            return;
        }
        clearAfterSend();
    };

    const voice = useVoiceInput({ textareaRef, onTranscript: handleTranscript, onLiveText: handleLiveText });
    const { voiceState, stopVoice, getVoiceLevel } = voice;

    const handleSend = () => {
        if (isStreaming) return;
        if (voiceState === "recording") { void stopVoice("send"); return; }
        if (!message.trim() && files.length === 0 && pastedContent.length === 0 && attachedElements.length === 0) return;
        sendNow({ message, files, pastedContent, model: selectedModel, isThinkingEnabled, elements: attachedElements.length ? attachedElements : undefined });
        clearAfterSend();
    };

    const handleSteer = () => {
        if (!onSteer) return;
        if (voiceState === "recording") { void stopVoice("steer"); return; }
        if (!message.trim() && files.length === 0 && pastedContent.length === 0 && attachedElements.length === 0) return;
        onSteer({ message, files, pastedContent, model: selectedModel, isThinkingEnabled, elements: attachedElements.length ? attachedElements : undefined });
        clearAfterSend();
    };

    const handleQueue = () => {
        if (!onQueue) return handleSteer();
        if (voiceState === "recording") { void stopVoice("send"); return; }
        if (!message.trim() && files.length === 0 && pastedContent.length === 0 && attachedElements.length === 0) return;
        onQueue({ message, files, pastedContent, model: selectedModel, isThinkingEnabled, elements: attachedElements.length ? attachedElements : undefined });
        clearAfterSend();
    };

    const showSuggestion = Boolean(suggestion) && !message && !isStreaming && voiceState === "idle";

    const handleKeyDown = (e: React.KeyboardEvent) => {
        // An input method's Enter and arrows pick its candidates; they don't send or move menus.
        if (isComposingKey(e)) return;
        if (handleMenuKey(e)) return;
        if (e.key === "Tab" && !e.shiftKey && showSuggestion) {
            e.preventDefault();
            setMessage(suggestion!);
            pendingCursorRef.current = suggestion!.length;
            return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (isStreaming) {
                if (e.ctrlKey || e.metaKey) handleSteer();
                else handleQueue();
            } else {
                handleSend();
            }
        }
    };

    const hasContent = Boolean(message.trim() || files.length > 0 || pastedContent.length > 0 || attachedElements.length > 0);
    // A message that starts with a slash command shows the command in the link color, as it will in the chat.
    const commandMatch = /^\/([A-Za-z0-9_:-]+)/.exec(message);
    const typedCommand = commandMatch ? { name: commandMatch[1], rest: message.slice(commandMatch[0].length) } : null;

    return (
        <div data-composer className={`relative w-full ${widthClass} mx-auto transition-all duration-300 font-sans`}>
            {/* Mascot sitting on the composer's top edge; behind it so its feet tuck under the border. */}
            {mascot && (
                <div aria-hidden className="pointer-events-none absolute bottom-full right-3 md:right-1 -mb-[10px] z-0">
                    <NyxsMascot mood={mascot} size={96} />
                </div>
            )}
            {topBar}
            <div className="!box-content flex flex-col mx-2 md:mx-0 items-stretch transition-[border-color,box-shadow] duration-[120ms] ease-[cubic-bezier(.32,.72,0,1)] relative z-10 rounded-[8px] cursor-text border border-black/[0.22] dark:border-white/[0.14] shadow-[0_2px_14px_0_rgba(0,0,0,0.05)] hover:border-text-500/50 focus-within:border-text-500/70 bg-bg-100 font-sans antialiased">
                {slashOpen && slashItems.length > 0 && (
                    <SlashMenu slashItems={slashItems} slashIndex={slashIndex} setSlashIndex={setSlashIndex} slashHovering={slashHovering} setSlashHovering={setSlashHovering} selectSlash={selectSlash} />
                )}
                {mentionOpen && mentionItems.length > 0 && (
                    <MentionMenu mentionItems={mentionItems} mentionIndex={mentionIndex} setMentionIndex={setMentionIndex} selectMention={selectMention} />
                )}
                <div className="flex flex-col px-3 py-[7px] gap-1.5">
                    <ComposerAttachments
                        attachedElements={attachedElements}
                        setAttachedElements={setAttachedElements}
                        files={files}
                        setFiles={setFiles}
                        pastedContent={pastedContent}
                        setPastedContent={setPastedContent}
                    />

                    <div className="flex items-end gap-1.5">
                        {!sideChat && (
                            <button onClick={pickFiles} className="inline-flex items-center justify-center shrink-0 transition-colors duration-[120ms] ease-[cubic-bezier(.32,.72,0,1)] h-7 w-7 rounded-[7px] active:scale-95 text-text-400 hover:text-text-200 hover:bg-bg-200 mb-0.5" type="button" aria-label={t.attachFile}>
                                <Icons.Plus className="w-4 h-4" />
                            </button>
                        )}
                        <div className="relative flex-1 min-w-0 self-center">
                            <div className="relative max-h-96 w-full overflow-y-auto custom-scrollbar font-sans break-words transition-opacity duration-[120ms] min-h-[19px]">
                                {typedCommand && (
                                    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 whitespace-pre-wrap break-words text-[13px] leading-[19px] font-normal antialiased text-text-100">
                                        <span className="text-text-400">/</span>
                                        <span className="text-[color:var(--link)]">{typedCommand.name}</span>
                                        {typedCommand.rest}
                                        {"​"}
                                    </div>
                                )}
                                <textarea
                                    ref={textareaRef}
                                    value={message}
                                    onChange={(e) => { setMessage(e.target.value); refreshSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                                    onSelect={(e) => refreshSuggestions(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                                    onPaste={handlePaste}
                                    onKeyDown={handleKeyDown}
                                    placeholder={voiceState === "recording" ? t.voiceRecording : showSuggestion ? previewSuggestion(suggestion!) : placeholder ?? t.placeholder}
                                    aria-label={placeholder ?? t.placeholder}
                                    className={`relative w-full bg-transparent border-0 outline-none ${typedCommand ? "text-transparent caret-text-100" : "text-text-100"} text-[13px] placeholder:text-text-500 ${voiceState === "recording" ? "placeholder:italic" : ""} resize-none overflow-hidden py-0 leading-[19px] block font-normal antialiased`}
                                    rows={1}
                                    autoFocus
                                    style={{ minHeight: "19px" }}
                                />
                            </div>
                        </div>
                        {voiceState === "recording" && <VoiceWaveform getLevel={getVoiceLevel} />}
                        {!isStreaming && (hasContent || voiceState === "recording") && (
                            <button
                                onClick={handleSend}
                                className="inline-flex items-center justify-center shrink-0 transition-colors duration-[120ms] ease-[cubic-bezier(.32,.72,0,1)] h-7 w-7 rounded-[7px] active:scale-95 text-text-300 hover:text-text-100 hover:bg-bg-200 mb-0.5 animate-fade-in"
                                type="button"
                                aria-label={t.sendMessage}
                            >
                                <Icons.Enter className="w-4 h-4" />
                            </button>
                        )}
                        {isStreaming && (
                            <div className="group/stop relative flex items-center mb-0.5">
                                <span className="app-tooltip pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/stop:flex items-center gap-2 whitespace-nowrap px-2.5 py-1.5 shadow-xl z-50">
                                    <span className="text-[12px] font-semibold">{t.stop}</span>
                                    <span className="text-[11px] app-tooltip-muted">Esc</span>
                                </span>
                                <button
                                    onClick={onStop}
                                    className="inline-flex items-center justify-center shrink-0 transition-colors duration-[120ms] ease-[cubic-bezier(.32,.72,0,1)] h-7 w-7 rounded-[7px] active:scale-95 text-text-200 hover:text-text-100 hover:bg-bg-200 animate-fade-in"
                                    type="button"
                                    aria-label={t.stop}
                                >
                                    <svg viewBox="0 0 16 16" className="w-4 h-4" aria-hidden>
                                        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                                        <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor" />
                                    </svg>
                                </button>
                            </div>
                        )}
                        <MicButton voice={voice} />
                    </div>
                </div>
            </div>
            <div className="flex items-center justify-between gap-1.5 mx-2 md:mx-0 px-1 pt-1.5">
                <div className="flex items-center gap-1 min-w-0">
                    {lockWorkspace ? (
                        <LockedMachineChip workspace={workspace} />
                    ) : (
                        <WorkspaceChips
                            workspace={workspace}
                            recentWorkspaces={recentWorkspaces}
                            onSelect={onSelectWorkspace}
                            onClose={onCloseWorkspace}
                            onPick={onPickWorkspace}
                        />
                    )}
                    {!sideChat && <PermissionSelector mode={permissionMode} onChange={(m) => onPermissionModeChange?.(m)} allowBypass={allowPermissionBypass} />}
                </div>
                <div className="flex items-center gap-1">
                    <ModelSelector
                        models={models}
                        selectedModel={selectedModel}
                        onSelect={onModelChange}
                        onConnectProvider={onOpenSettings}
                        onManageModels={onManageModels}
                        effort={effort}
                        onEffortChange={(e) => onEffortChange?.(e)}
                        effortLevels={effortLevels}
                        recommendedEffort={recommendedEffort}
                    />
                    {!sideChat && <ContextMeter used={contextUsed} total={contextTotal} loadDetails={onLoadContextDetails} loadPlanUsage={onLoadPlanUsage} cachedPlanUsage={cachedPlanUsage} sessionUsage={sessionUsage} />}
                </div>
            </div>

            {isDragging && (
                <div className="absolute inset-0 bg-bg-200/90 border-2 border-dashed border-accent rounded-[8px] z-50 flex flex-col items-center justify-center backdrop-blur-sm pointer-events-none">
                    <Icons.Archive className="w-10 h-10 text-accent mb-2 animate-bounce" />
                    <p className="text-accent font-medium">{t.dropFiles}</p>
                </div>
            )}

            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; void focusComposer(); }} />
        </div>
    );
};

export default ClaudeChatInput;
