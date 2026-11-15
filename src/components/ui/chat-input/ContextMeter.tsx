import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatUsd } from "@/lib/pricing";
import { getLanguage, useTranslations, type Translations } from "@/lib/i18n";
import { contextCategoryId, type ContextBreakdown, type ContextCategory, type PlanUsage, type PlanLimit } from "@/lib/claudeCode";
import { planLimitLabel, resetLabel } from "@/lib/planLimits";
import type { SessionUsage } from "./types";

const formatCtx = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${n}`;
};

// Colour, label and tooltip for the slices, found by their stable id (the CLI's names are only
// display text). Unknown ids keep their own label.
const CONTEXT_SLICES: Record<string, { label: keyof Translations["chatInput"]; tip?: keyof Translations["chatInput"]; dot: string }> = {
    "system-prompt": { label: "ctxSystemPrompt", tip: "ctxTipSystemPrompt", dot: "bg-sky-500" },
    "system-tools": { label: "ctxSystemTools", tip: "ctxTipSystemTools", dot: "bg-violet-500" },
    "mcp-tools": { label: "ctxMcpTools", tip: "ctxTipMcpTools", dot: "bg-fuchsia-500" },
    "mcp-instructions": { label: "ctxMcpInstructions", tip: "ctxTipMcpInstructions", dot: "bg-indigo-400" },
    "custom-agents": { label: "ctxAgents", tip: "ctxTipAgents", dot: "bg-pink-500" },
    "memory-files": { label: "ctxMemory", tip: "ctxTipMemory", dot: "bg-amber-500" },
    skills: { label: "ctxSkills", tip: "ctxTipSkills", dot: "bg-teal-500" },
    messages: { label: "ctxMessages", tip: "ctxTipMessages", dot: "bg-orange-500" },
    "autocompact-buffer": { label: "ctxBuffer", tip: "ctxTipBuffer", dot: "bg-text-500/50" },
    "system-tools-deferred": { label: "ctxSystemToolsDeferred", tip: "ctxTipDeferred", dot: "bg-violet-300" },
    "mcp-tools-deferred": { label: "ctxMcpToolsDeferred", tip: "ctxTipDeferred", dot: "bg-fuchsia-300" },
};

const sliceMeta = (category: ContextCategory) =>
    CONTEXT_SLICES[category.id ?? contextCategoryId(category.name)] ?? CONTEXT_SLICES[contextCategoryId(category.name)];

/** Keeps the end of a path or tool name visible, where the meaningful part is. */
function shortenMiddle(text: string, max: number): string {
    if (text.length <= max) return text;
    const keep = Math.max(6, Math.floor((max - 1) / 2));
    return `${text.slice(0, keep)}…${text.slice(-(max - keep - 1))}`;
}

/** Asks the context meter to open, e.g. from the plan limit warning's "View usage". */
export const OPEN_CONTEXT_METER_EVENT = "nyxs:open-context-meter";

const PlanLimitRow: React.FC<{ limit: PlanLimit }> = ({ limit }) => {
    const t = useTranslations().chatInput;
    const label = planLimitLabel(limit, t);
    const reset = limit.resetsAt ? resetLabel(limit.kind, limit.resetsAt, t) : "";
    const color = limit.utilization >= 100 ? "bg-red-500" : limit.utilization >= 80 ? "bg-amber-500" : "bg-accent";
    return (
        <div className="px-3 py-1">
            <div className="flex items-baseline gap-2">
                <span className="shrink-0 text-[13px] text-text-100">{label}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[12px] text-text-400">{reset}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-text-400">{limit.utilization}%</span>
            </div>
            <div className="mt-0.5 h-1 w-full rounded-full bg-bg-300 overflow-hidden">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${limit.utilization}%` }} />
            </div>
        </div>
    );
};

/** Context ring; a click opens how full this chat's context is and, for Claude, the plan limits. */
export const ContextMeter: React.FC<{
    used: number;
    total: number;
    loadDetails?: () => Promise<ContextBreakdown | null>;
    loadPlanUsage?: () => Promise<PlanUsage | null>;
    cachedPlanUsage?: () => PlanUsage | null;
    sessionUsage?: SessionUsage | null;
}> = ({ used, total, loadDetails, loadPlanUsage, cachedPlanUsage, sessionUsage }) => {
    const t = useTranslations().chatInput;
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [details, setDetails] = useState<ContextBreakdown | null>(null);
    const [plan, setPlan] = useState<{ loading: boolean; value: PlanUsage | null }>({ loading: false, value: null });
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handle = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [open]);

    const toggle = () => {
        if (open) { setOpen(false); return; }
        setOpen(true);
        setDetails(null);
        loadDetails?.().then(setDetails, () => setDetails(null));
        if (loadPlanUsage) {
            setPlan({ loading: true, value: cachedPlanUsage?.() ?? null });
            loadPlanUsage().then(
                (value) => setPlan({ loading: false, value }),
                () => setPlan((p) => ({ ...p, loading: false })),
            );
        }
    };

    const toggleRef = useRef(toggle);
    useEffect(() => { toggleRef.current = toggle; });
    const openRef = useRef(open);
    useEffect(() => { openRef.current = open; }, [open]);
    useEffect(() => {
        const onOpen = () => { if (!openRef.current) toggleRef.current(); };
        window.addEventListener(OPEN_CONTEXT_METER_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_CONTEXT_METER_EVENT, onOpen);
    }, []);

    // Claude Code's own measurement wins when it is there: it knows the real window size.
    const usedTokens = details?.totalTokens || used;
    const windowTokens = details?.maxTokens || total;
    const pct = windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : 0;
    const r = 7;
    const circumference = 2 * Math.PI * r;
    const ringPct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const color = ringPct >= 90 ? "text-red-400" : ringPct >= 70 ? "text-yellow-400" : "text-accent";
    const share = (n: number) => (windowTokens > 0 ? (n / windowTokens) * 100 : 0);
    const pctText = (fraction: number) =>
        new Intl.NumberFormat(getLanguage(), { style: "percent", maximumFractionDigits: 1 }).format(
            Math.max(0, Math.min(1, fraction)),
        );
    const rowPct = (tokens: number) => pctText(windowTokens > 0 ? tokens / windowTokens : 0);
    const usedOnly = (details?.categories ?? []).filter((c) => c.kind === "used" && c.tokens > 0);
    const bufferSlices = (details?.categories ?? []).filter((c) => c.kind === "buffer" && c.tokens > 0);
    // Deferred tools are only listed for the model, not loaded, so they take no room yet.
    const deferredSlices = (details?.categories ?? []).filter((c) => c.kind === "deferred" && c.tokens > 0);
    const barSlices = [...usedOnly, ...bufferSlices];
    const detailRows = [...usedOnly, ...deferredSlices, ...bufferSlices];
    const freeTokens = Math.max(0, windowTokens - barSlices.reduce((n, c) => n + c.tokens, 0));
    const note = details?.estimated
        ? t.ctxNoteEstimated
        : (details?.categories ?? []).some((c) => c.childrenEstimated)
            ? t.ctxNoteChildrenEstimated
            : t.ctxNote;

    const toggleGroup = (id: string) =>
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const categoryRow = (category: ContextCategory) => {
        const id = category.id ?? contextCategoryId(category.name);
        const meta = sliceMeta(category);
        const label = meta ? t[meta.label] : category.name;
        const tip = meta?.tip ? t[meta.tip] : undefined;
        const children = category.children ?? [];
        const canOpen = children.length > 0;
        const isOpen = expandedGroups.has(id);
        const dim = category.kind === "deferred" ? "text-text-500" : "text-text-400";
        const row = (
            <>
                <span className={`shrink-0 w-2 h-2 rounded-full ${meta?.dot ?? "bg-slate-400"}`} />
                <span
                    className={`min-w-0 flex-1 truncate text-[12px] text-text-200 ${tip ? "underline decoration-dotted decoration-text-500/70 underline-offset-2" : ""}`}
                    data-tooltip={tip}
                >
                    {label}
                </span>
                <span className="shrink-0 w-4 text-right text-[11px] tabular-nums text-text-400">
                    {canOpen ? children.length : ""}
                </span>
                <span className={`shrink-0 text-[12px] tabular-nums ${dim}`}>{formatCtx(category.tokens)}</span>
                <span className={`shrink-0 w-12 text-right text-[12px] tabular-nums ${dim}`}>
                    {category.kind === "deferred" ? "—" : rowPct(category.tokens)}
                </span>
                {canOpen ? (
                    <ChevronRight className={`shrink-0 w-3 h-3 text-text-400 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                ) : (
                    <span className="shrink-0 w-3" />
                )}
            </>
        );
        return (
            <div key={id} className="py-[2px]">
                {canOpen ? (
                    <button type="button" onClick={() => toggleGroup(id)} className="w-full flex items-center gap-2 text-left">
                        {row}
                    </button>
                ) : (
                    <div className="w-full flex items-center gap-2">{row}</div>
                )}
                {canOpen && isOpen && (
                    <>
                        <div className="ml-4 mt-0.5 max-h-32 overflow-y-auto custom-scrollbar border-l border-bg-300 pl-2">
                            {children.map((child, i) => (
                                <div key={`${child.id ?? child.name}-${i}`} className="flex items-baseline gap-2 py-[2px]">
                                    <span className="min-w-0 flex-1 truncate text-[11px] text-text-300">
                                        {shortenMiddle(child.name, 46)}
                                    </span>
                                    <span className="shrink-0 text-[11px] tabular-nums text-text-400">
                                        {formatCtx(child.tokens)}
                                    </span>
                                </div>
                            ))}
                        </div>
                        {category.childrenEstimated && (
                            <p className="ml-4 pl-2 mt-0.5 text-[11px] text-text-400">{t.ctxEstimatedDetail}</p>
                        )}
                    </>
                )}
            </div>
        );
    };

    return (
        <div className="relative flex items-center" ref={ref}>
            <button
                type="button"
                onClick={toggle}
                aria-label={t.contextWindow}
                aria-expanded={open}
                className={`group inline-flex items-center justify-center h-6 w-6 rounded-[5px] transition-colors ${open ? "bg-bg-200" : "hover:bg-bg-200"}`}
            >
                <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
                    <circle cx="10" cy="10" r={r} fill="none" strokeWidth="2.5" className="stroke-bg-300" />
                    <circle
                        cx="10"
                        cy="10"
                        r={r}
                        fill="none"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        strokeDashoffset={circumference - (circumference * ringPct) / 100}
                        className={`stroke-current ${color} transition-[stroke-dashoffset] duration-500`}
                    />
                </svg>
                {!open && (
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block whitespace-nowrap app-tooltip px-2.5 py-1.5 text-left shadow-xl z-50">
                        <span className="block text-[12px] font-semibold">{t.contextWindow}: {ringPct}%</span>
                        <span className="block text-[11px] app-tooltip-muted">{formatCtx(used)} / {formatCtx(total)}</span>
                    </span>
                )}
            </button>
            {open && (
                <div data-mod-menu data-composer-menu role="dialog" className="absolute bottom-full right-0 mb-2 w-[24rem] bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-50 py-1">
                    <button
                        type="button"
                        disabled={detailRows.length === 0}
                        onClick={() => setExpanded((v) => !v)}
                        className="w-full px-3 py-1.5 text-left disabled:cursor-default"
                    >
                        <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-100">{t.ctxTitle}</span>
                            {detailRows.length > 0 && (
                                <ChevronDown className={`shrink-0 w-3.5 h-3.5 text-text-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
                            )}
                        </span>
                        <span className="mt-0.5 flex items-baseline gap-2">
                            <span className="text-[12px] tabular-nums text-text-400">
                                {t.ctxUsed.replace("{pct}", pctText(windowTokens > 0 ? usedTokens / windowTokens : 0))}
                            </span>
                            <span className="ml-auto text-[12px] tabular-nums text-text-400">
                                {formatCtx(usedTokens)} / {formatCtx(windowTokens)}
                            </span>
                        </span>
                    </button>
                    <div className="px-3">
                        <div className="h-1.5 w-full rounded-full bg-bg-300 overflow-hidden flex">
                            {barSlices.length > 0 ? (
                                barSlices.map((c) => (
                                    <div key={c.id ?? c.name} className={`h-full ${sliceMeta(c)?.dot ?? "bg-slate-400"}`} style={{ width: `${share(c.tokens)}%` }} />
                                ))
                            ) : (
                                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                            )}
                        </div>
                    </div>
                    {expanded && detailRows.length > 0 && (
                        <div className="px-3 pt-2">
                            {detailRows.map(categoryRow)}
                            <div className="flex items-center gap-2 py-[3px]">
                                <span className="shrink-0 w-2 h-2 rounded-full bg-bg-300" />
                                <span className="min-w-0 flex-1 truncate text-[12px] text-text-200">{t.ctxFree}</span>
                                <span className="shrink-0 w-4" />
                                <span className="shrink-0 text-[12px] tabular-nums text-text-400">{formatCtx(freeTokens)}</span>
                                <span className="shrink-0 w-12 text-right text-[12px] tabular-nums text-text-400">{rowPct(freeTokens)}</span>
                                <span className="shrink-0 w-3" />
                            </div>
                            <p className="mt-1.5 text-[11px] text-text-400">{note}</p>
                        </div>
                    )}
                    {sessionUsage && sessionUsage.inputTokens > 0 && (
                        <div className="mt-1.5 pt-1.5 border-t border-bg-300 px-3 pb-0.5">
                            <p className="pb-0.5 text-[12px] text-text-400">{t.sessionUsage}</p>
                            <div className="flex items-baseline gap-2 py-[2px]">
                                <span className="min-w-0 flex-1 truncate text-[12px] text-text-200">{t.sessionCost}</span>
                                <span className="shrink-0 text-[12px] tabular-nums text-text-400">
                                    {sessionUsage.costUsd > 0 ? formatUsd(sessionUsage.costUsd) : "—"}
                                </span>
                            </div>
                            <div className="flex items-baseline gap-2 py-[2px]">
                                <span className="min-w-0 flex-1 truncate text-[12px] text-text-200">{t.cacheHitRate}</span>
                                <span className="shrink-0 text-[12px] tabular-nums text-text-400">
                                    {Math.round((sessionUsage.readTokens / sessionUsage.inputTokens) * 100)}% · {formatCtx(sessionUsage.readTokens)} / {formatCtx(sessionUsage.inputTokens)}
                                </span>
                            </div>
                        </div>
                    )}
                    <div className="mt-1.5 pt-1.5 border-t border-bg-300">
                        <p className="px-3 pb-0.5 text-[12px] text-text-400">{t.planUsageLimits}</p>
                        {!loadPlanUsage ? (
                            <p className="px-3 py-1 text-[12px] text-text-400">{t.planUsageNotReported}</p>
                        ) : plan.value && plan.value.limits.length > 0 ? (
                            plan.value.limits.map((l) => <PlanLimitRow key={`${l.kind}-${l.model ?? ""}`} limit={l} />)
                        ) : (
                            <p className="px-3 py-1 text-[12px] text-text-400">{plan.loading ? t.usageLoading : t.planUsageUnavailable}</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
