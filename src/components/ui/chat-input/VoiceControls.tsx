import React, { useState, useEffect } from "react";
import { useTranslations } from "@/lib/i18n";
import { useCloseOnBlur } from "@/lib/useCloseOnBlur";
import { Icons } from "./icons";
import type { VoiceInput } from "./useVoiceInput";

const WAVE_BARS = 18;

/** Scrolling level meter shown while dictating: bars for sound, dots for silence. */
export const VoiceWaveform: React.FC<{ getLevel: () => number }> = ({ getLevel }) => {
    const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
    useEffect(() => {
        const id = setInterval(() => setLevels((prev) => [...prev.slice(1), getLevel()]), 80);
        return () => clearInterval(id);
    }, [getLevel]);
    return (
        <div className="flex items-center gap-[3px] h-5 mb-0.5 mr-1 shrink-0" aria-hidden>
            {levels.map((l, i) => (
                <span
                    key={i}
                    className="w-[2px] rounded-full bg-text-200 transition-[height] duration-75"
                    style={{ height: l < 0.06 ? 2 : Math.min(18, 4 + l * 22) }}
                />
            ))}
        </div>
    );
};

/** The mic: hold or click to dictate, right-click to pick the microphone. */
export const MicButton: React.FC<{ voice: VoiceInput }> = ({ voice }) => {
    const t = useTranslations().chatInput;
    const { voiceState, micMenuOpen, setMicMenuOpen, mics, micId, chooseMic, onMicPointerDown, onMicPointerUp, onMicClick, openMicMenu } = voice;
    useCloseOnBlur(micMenuOpen, () => setMicMenuOpen(false));
    return (
        <div className="group/mic relative flex items-center mb-0.5">
            {micMenuOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setMicMenuOpen(false)} onContextMenu={(e) => { e.preventDefault(); setMicMenuOpen(false); }} />
                    <div data-mod-menu data-webview-hole className="absolute bottom-full right-0 mb-2 z-50 w-64 bg-bg-200 border border-bg-300 rounded-[8px] shadow-2xl p-1.5" role="menu" aria-label={t.voiceSelectMic}>
                        <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-text-400">{t.voiceSelectMic}</div>
                        {[{ deviceId: "", label: t.voiceDefaultMic }, ...mics.filter((m) => m.deviceId && m.deviceId !== "default")].map((m, i) => (
                            <button
                                key={m.deviceId || "default"}
                                type="button"
                                role="menuitemradio"
                                aria-checked={micId === m.deviceId}
                                onClick={() => chooseMic(m.deviceId)}
                                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-[13px] text-left text-text-100 hover:bg-bg-300 transition-colors"
                            >
                                <span className="truncate">{m.label || `${t.voiceMicFallback} ${i}`}</span>
                                {micId === m.deviceId && <Icons.Check className="w-4 h-4 shrink-0 text-accent" />}
                            </button>
                        ))}
                    </div>
                </>
            )}
            {!micMenuOpen && voiceState !== "transcribing" && (
                <span className="app-tooltip pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover/mic:block w-max max-w-[13.5rem] whitespace-normal px-2.5 py-1.5 text-left shadow-xl z-50">
                    {voiceState === "recording" ? (
                        <span className="block text-[12px] font-semibold">{t.voiceRecordingHint}</span>
                    ) : (
                        <>
                            <span className="block text-[12px] font-semibold">{t.voiceHoldToRecord}</span>
                            <span className="block text-[11px] leading-snug app-tooltip-muted mt-0.5">{t.voiceRightClickSettings}</span>
                        </>
                    )}
                </span>
            )}
            <button
                onPointerDown={onMicPointerDown}
                onPointerUp={onMicPointerUp}
                onPointerCancel={onMicPointerUp}
                onClick={onMicClick}
                onContextMenu={(e) => void openMicMenu(e)}
                disabled={voiceState === "transcribing"}
                className={`inline-flex items-center justify-center shrink-0 transition-all h-7 w-7 rounded-[7px] active:scale-95 select-none touch-none ${
                    voiceState === "recording"
                        ? "text-accent bg-accent/15 hover:bg-accent/20"
                        : voiceState === "transcribing"
                          ? "text-accent"
                          : "text-text-400 hover:text-text-200 hover:bg-bg-200"
                }`}
                type="button"
                aria-label={voiceState === "recording" ? t.voiceRecordingHint : t.voiceHoldToRecord}
                aria-haspopup="menu"
                aria-expanded={micMenuOpen}
                aria-pressed={voiceState === "recording"}
            >
                {voiceState === "transcribing" ? (
                    <Icons.Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <Icons.Mic className="w-4 h-4" />
                )}
            </button>
        </div>
    );
};
