import React, { useState, useRef, useEffect, useCallback } from "react";
import { Hand, ListChecks, PencilLine, ShieldOff, Sparkles, type LucideIcon } from "lucide-react";
import { useMenuKeys, useOpenComposerMenu } from "@/lib/composerMenus";
import { useTranslations, type Translations } from "@/lib/i18n";
import { Icons } from "./icons";
import type { PermissionMode } from "./types";

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
    { id: "auto", label: "Auto" },
    { id: "ask", label: "Manual" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" },
    { id: "skip", label: "Skip permissions" },
];

const MODE_LABEL_KEY: Record<PermissionMode, keyof Translations["chatInput"]> = {
    ask: "modeAsk",
    acceptEdits: "modeAcceptEdits",
    plan: "modePlan",
    auto: "modeAuto",
    skip: "modeSkip",
};

const MODE_ICON: Record<PermissionMode, LucideIcon> = {
    auto: Sparkles,
    ask: Hand,
    acceptEdits: PencilLine,
    plan: ListChecks,
    skip: ShieldOff,
};

const BYPASS_MODES: PermissionMode[] = ["skip"];

const MODE_DESC_KEY: Record<PermissionMode, keyof Translations["menu"]> = {
    ask: "descAsk",
    acceptEdits: "descAcceptEdits",
    plan: "descPlan",
    auto: "descAuto",
    skip: "descSkip",
};

export const PermissionSelector: React.FC<{ mode: PermissionMode; onChange: (m: PermissionMode) => void; allowBypass?: boolean }> = ({ mode, onChange, allowBypass = false }) => {
    const t = useTranslations().chatInput;
    const tMenu = useTranslations().menu;
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handle = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, []);
    const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0];
    const CurrentIcon = MODE_ICON[current.id];
    const show = useCallback(() => setOpen(true), []);
    const close = useCallback(() => setOpen(false), []);
    const pick = useCallback((i: number) => {
        const m = PERMISSION_MODES[i];
        if (!m || (!allowBypass && BYPASS_MODES.includes(m.id))) return;
        onChange(m.id);
        setOpen(false);
    }, [allowBypass, onChange]);
    useOpenComposerMenu("mode", ref, show);
    useMenuKeys(open, pick, close);
    return (
        <div className="relative flex" ref={ref}>
            <button
                onClick={() => setOpen(!open)}
                // Same colors in every mode: a red chip was hard to read for low-vision users, and
                // the shield-off icon already marks that permissions are skipped.
                className={`inline-flex items-center gap-1 h-5 rounded-[5px] px-2 text-[12px] font-medium transition-colors duration-[120ms] whitespace-nowrap ${
                    open ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200"
                }`}
                type="button"
            >
                <CurrentIcon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                <span className="leading-none">
                    {t[MODE_LABEL_KEY[current.id]]}
                </span>
            </button>
            {open && (
                <div data-composer-menu role="menu" className="absolute bottom-full left-0 mb-2 w-64 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-50 p-1">
                    <div className="px-2 pt-0.5 pb-1 text-[12px] text-text-400">{t.mode}</div>
                    {PERMISSION_MODES.map((m, idx) => {
                        const locked = !allowBypass && BYPASS_MODES.includes(m.id);
                        const ModeIcon = MODE_ICON[m.id];
                        return (
                        <button
                            key={m.id}
                            onClick={() => { onChange(m.id); setOpen(false); }}
                            className={`w-full text-left px-2 py-1 rounded-[5px] flex items-start gap-2 transition-colors hover:bg-bg-200 ${locked ? "opacity-70" : ""}`}
                        >
                            {/* 14px and 4px down: centred on the title's letters, which sit
                                about 1px below the middle of its 20px line. */}
                            <ModeIcon className="w-3.5 h-3.5 mt-1 shrink-0 text-text-300" aria-hidden />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="flex items-center gap-1.5">
                                    <span className="text-[13px] leading-5 text-text-100">{t[MODE_LABEL_KEY[m.id]]}</span>
                                    {m.id === "auto" && <span className="px-1 rounded-[3px] text-[10px] leading-4 font-medium bg-bg-200 text-text-400">{tMenu.recommended}</span>}
                                </span>
                                <span className="text-[11px] leading-tight text-text-400">{tMenu[MODE_DESC_KEY[m.id]]}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2 pt-0.5">
                                {mode === m.id && <Icons.Check className="w-4 h-4 text-accent" />}
                                {locked
                                    ? <Icons.Lock className="w-3.5 h-3.5 text-text-400" data-tooltip="Requires enabling permission bypass in settings" />
                                    : <span className="text-[11px] tabular-nums text-text-400">{idx + 1}</span>}
                            </span>
                        </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
