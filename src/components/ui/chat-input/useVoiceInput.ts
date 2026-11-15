import React, { useState, useRef, useEffect, useCallback } from "react";
import { VoiceRecorder, TranscribeError, transcribeBlob, MAX_SECONDS, listMicrophones, ensureMicPermission, type MicDevice } from "@/lib/transcribe";
import { StreamingDictation, StreamUnavailable } from "@/lib/transcribeStream";
import { currentWorkspace } from "@/lib/filePaths";
import { loadMicId, saveMicId } from "./storage";

const HOLD_TO_RECORD_MS = 350;
/** After live dictation turned out unavailable, the recorded clip is used this long without
 *  trying again, so each dictation doesn't wait for a stream that isn't there. */
const STREAM_RETRY_MS = 10 * 60_000;
let streamUnavailableUntil = 0;

/** What to do with the draft once the transcript arrives: keep it, send it (queued while the
 *  session works), or steer the running turn with it. */
export type VoiceSend = false | "send" | "steer";

interface VoiceInputOptions {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    /** Gets what was said once it arrives, and whether it should go out with the draft. */
    onTranscript: (text: string, send: VoiceSend) => void;
    /** The transcript so far while the user speaks (live dictation only). */
    onLiveText?: (text: string) => void;
}

/** A dictation in progress: live (streamed) or a recorded clip transcribed at the end. */
interface Dictation {
    level(): number;
    stop(): Promise<string>;
    cancel(): void;
}

function recordedClip(recorder: VoiceRecorder): Dictation {
    return {
        level: () => recorder.level(),
        stop: async () => transcribeBlob(await recorder.stop()),
        cancel: () => recorder.cancel(),
    };
}

/** Words the transcriber should spell right: the app's name and the open project's. */
function dictationKeyterms(): string[] {
    const project = currentWorkspace()?.split(/[\\/]/).filter(Boolean).pop();
    return ["Nyxs", ...(project ? [project] : [])];
}

/** Opens live dictation, or the recorder when the backend has none. Throws without a mic. */
async function openDictation(micId: string, onLiveText?: (text: string) => void): Promise<Dictation> {
    if (Date.now() >= streamUnavailableUntil) {
        const live = new StreamingDictation((text) => onLiveText?.(text));
        try {
            await live.start(micId || undefined, dictationKeyterms());
            return live;
        } catch (e) {
            if (e instanceof TranscribeError) throw e;
            if (e instanceof StreamUnavailable) streamUnavailableUntil = Date.now() + STREAM_RETRY_MS;
        }
    }
    const recorder = new VoiceRecorder();
    await recorder.start(micId || undefined);
    return recordedClip(recorder);
}

/** Dictation: the recorder, hold-to-record on the mic button, and the microphone menu. It works
 *  while the session is busy too, to dictate the next prompt or one to queue. */
export function useVoiceInput({ textareaRef, onTranscript, onLiveText }: VoiceInputOptions) {
    const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
    const recorderRef = useRef<Dictation | null>(null);
    const startingVoiceRef = useRef(false);
    const pendingStopRef = useRef<VoiceSend | null>(null);
    const cancelRequestedRef = useRef(false);
    const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pressRef = useRef<{ at: number; stopOnRelease: boolean } | null>(null);
    const releaseRequestedRef = useRef(false);
    const [micMenuOpen, setMicMenuOpen] = useState(false);
    const [mics, setMics] = useState<MicDevice[]>([]);
    const [micId, setMicId] = useState<string>(() => loadMicId());
    // The chat box's latest handler: transcribing takes a while, and what the user typed meanwhile
    // is in the newer one, not in the one of the render where dictation stopped.
    const onTranscriptRef = useRef(onTranscript);
    const onLiveTextRef = useRef(onLiveText);
    useEffect(() => {
        onTranscriptRef.current = onTranscript;
        onLiveTextRef.current = onLiveText;
    });

    const startVoice = async () => {
        if (voiceState !== "idle" || startingVoiceRef.current) return;
        startingVoiceRef.current = true;
        releaseRequestedRef.current = false;
        pendingStopRef.current = null;
        cancelRequestedRef.current = false;
        // Listening shows at once: the microphone records while live dictation connects.
        setVoiceState("recording");
        let recorder: Dictation;
        try {
            recorder = await openDictation(micId, (text) => onLiveTextRef.current?.(text));
        } catch {
            setVoiceState("idle");
            return;
        } finally {
            startingVoiceRef.current = false;
        }
        if (cancelRequestedRef.current) {
            recorder.cancel();
            setVoiceState("idle");
            return;
        }
        recorderRef.current = recorder;
        textareaRef.current?.focus();
        autoStopRef.current = setTimeout(() => void stopVoice(false), MAX_SECONDS * 1000);
        // Released, Enter or a send while it was still connecting.
        const pending = releaseRequestedRef.current ? false : pendingStopRef.current;
        releaseRequestedRef.current = false;
        pendingStopRef.current = null;
        if (pending !== null) void stopVoice(pending);
    };

    // `send` (Enter while listening) sends the draft plus the transcript once it arrives.
    const stopVoice = async (send: VoiceSend) => {
        const recorder = recorderRef.current;
        if (!recorder) {
            if (startingVoiceRef.current) pendingStopRef.current = send;
            return;
        }
        recorderRef.current = null;
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
        setVoiceState("transcribing");
        let text = "";
        try {
            text = await recorder.stop();
        } catch {
            // Transcription failed / empty / not signed in — fail silently (no alert).
        } finally {
            setVoiceState("idle");
        }
        onTranscriptRef.current(text, send);
    };

    /** Drops a recording in progress without transcribing it, for a box that closes mid-dictation. */
    const cancelVoice = useCallback(() => {
        if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
        pressRef.current = null;
        if (!recorderRef.current) {
            // Still connecting: it is dropped as soon as it opens.
            if (startingVoiceRef.current) {
                cancelRequestedRef.current = true;
                setVoiceState("idle");
            }
            return;
        }
        recorderRef.current.cancel();
        recorderRef.current = null;
        setVoiceState("idle");
    }, []);

    const getVoiceLevel = useCallback(() => recorderRef.current?.level() ?? 0, []);

    const toggleVoice = () => {
        if (voiceState === "recording") void stopVoice(false);
        else void startVoice();
    };

    const onMicPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0 || voiceState === "transcribing") return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setMicMenuOpen(false);
        if (voiceState === "recording") {
            pressRef.current = { at: Date.now(), stopOnRelease: true };
            return;
        }
        pressRef.current = { at: Date.now(), stopOnRelease: false };
        void startVoice();
    };

    const onMicPointerUp = () => {
        const press = pressRef.current;
        pressRef.current = null;
        if (!press) return;
        const held = Date.now() - press.at >= HOLD_TO_RECORD_MS;
        if (!press.stopOnRelease && !held) return;
        if (recorderRef.current) void stopVoice(false);
        else releaseRequestedRef.current = true;
    };

    const onMicClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (e.detail === 0) toggleVoice();
    };

    const openMicMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (micMenuOpen) { setMicMenuOpen(false); return; }
        setMicMenuOpen(true);
        await ensureMicPermission();
        setMics(await listMicrophones().catch(() => []));
    };

    const chooseMic = (id: string) => {
        setMicId(id);
        saveMicId(id);
        setMicMenuOpen(false);
    };

    useEffect(() => {
        if (!micMenuOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMicMenuOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [micMenuOpen]);

    useEffect(() => () => {
        if (autoStopRef.current) clearTimeout(autoStopRef.current);
        recorderRef.current?.cancel();
        cancelRequestedRef.current = true;
    }, []);

    return { voiceState, getVoiceLevel, stopVoice, cancelVoice, micMenuOpen, setMicMenuOpen, mics, micId, chooseMic, onMicPointerDown, onMicPointerUp, onMicClick, openMicMenu };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;
