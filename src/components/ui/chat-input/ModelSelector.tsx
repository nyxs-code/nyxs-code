import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, Server, SlidersHorizontal } from "lucide-react";
import { useCycleEffort, useMenuKeys, useOpenComposerMenu } from "@/lib/composerMenus";
import { useTranslations, type Translations } from "@/lib/i18n";
import type { EffortLevel } from "@/lib/effort";
import { Icons } from "./icons";
import { ModelLogo } from "./ModelLogo";
import type { Model } from "./types";

const EFFORT_LABEL_KEY: Record<EffortLevel, keyof Translations["chatInput"]> = {
    low: "effortLow",
    medium: "effortMedium",
    high: "effortHigh",
    extra: "effortExtra",
    max: "effortMax",
};

interface ProviderGroup {
    id: string;
    name: string;
    logo?: string;
    logoMono?: boolean;
    models: Model[];
}

/** The models by provider, in the order the providers first appear. */
function groupByProvider(models: Model[]): ProviderGroup[] {
    const groups = new Map<string, ProviderGroup>();
    for (const m of models) {
        const id = m.provider ?? "";
        let g = groups.get(id);
        if (!g) {
            // A provider without a logo shows its first model's (but see ProviderIcon for custom).
            const logo = m.providerLogo ? { logo: m.providerLogo, logoMono: m.providerLogoMono } : { logo: m.logo, logoMono: m.logoMono };
            g = { id, name: m.providerName ?? m.name, ...logo, models: [] };
            groups.set(id, g);
        }
        g.models.push(m);
    }
    return [...groups.values()];
}

const ProviderIcon: React.FC<{ group: ProviderGroup; className: string }> = ({ group, className }) =>
    // A custom endpoint has the server icon it has in Settings, not its first model's logo.
    group.id === "custom" ? (
        <Server aria-hidden className={`${className} shrink-0`} strokeWidth={1.8} />
    ) : group.logo ? (
        <ModelLogo model={group} className={className} />
    ) : (
        <span aria-hidden className={`${className} shrink-0 inline-flex items-center justify-center rounded-[4px] bg-bg-300 text-[9px] font-semibold text-text-200`}>
            {group.name.charAt(0).toUpperCase()}
        </span>
    );

/** The model menu: a tab per provider, its models, and the reasoning effort under them. */
export const ModelSelector: React.FC<{
    models: Model[];
    selectedModel: string;
    onSelect: (modelId: string) => void;
    onConnectProvider?: () => void;
    onManageModels?: () => void;
    effort: EffortLevel;
    onEffortChange: (e: EffortLevel) => void;
    /** The levels the selected model offers; null when it has none. */
    effortLevels: EffortLevel[] | null;
    recommendedEffort?: EffortLevel;
}> = ({ models, selectedModel, onSelect, onConnectProvider, onManageModels, effort, onEffortChange, effortLevels, recommendedEffort }) => {
    const t = useTranslations().chatInput;
    const tMenu = useTranslations().menu;
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);
    const tabsRef = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ left: false, right: false });
    const currentModel = models.find((m) => m.id === selectedModel) || models[0];

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsOpen(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const groups = groupByProvider(models);
    const group = groups.find((g) => g.id === tab) ?? groups[0];
    const q = query.trim().toLowerCase();
    // The search stays within the open provider's models.
    const shown = (group?.models ?? []).filter((m) => !q || `${m.name} ${m.description ?? ""}`.toLowerCase().includes(q));

    const open = () => {
        setIsOpen(true);
        setQuery("");
        setTab(currentModel?.provider ?? "");
    };
    // The numbers beside the models only show without a search, so only then do they pick.
    const pick = (i: number) => {
        const m = q ? undefined : shown[i];
        if (m) onSelect(m.id);
    };
    const cycleEffort = () => {
        if (!effortLevels?.length) return;
        onEffortChange(effortLevels[(effortLevels.indexOf(effort) + 1) % effortLevels.length]);
    };
    const measureTabs = () => {
        const el = tabsRef.current;
        if (!el) return;
        const left = el.scrollLeft > 1;
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    const scrollTabs = (dir: 1 | -1) => tabsRef.current?.scrollBy({ left: dir * 120, behavior: "smooth" });
    // On open, bring the current provider's tab into view and see which edges hide providers.
    useLayoutEffect(() => {
        if (!isOpen) return;
        tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
        measureTabs();
    }, [isOpen, groups.length]);
    const tabsOverflow = edges.left || edges.right;
    const tabsMask = tabsOverflow
        ? `linear-gradient(90deg, ${edges.left ? "transparent" : "#000"}, #000 16px, #000 calc(100% - 16px), ${edges.right ? "transparent" : "#000"})`
        : undefined;
    useOpenComposerMenu("model", dropdownRef, open);
    useCycleEffort(dropdownRef, cycleEffort);
    useMenuKeys(isOpen, pick, () => setIsOpen(false));

    return (
        <div className="relative flex" ref={dropdownRef}>
            <button
                onClick={() => (isOpen ? setIsOpen(false) : open())}
                className={`inline-flex items-center justify-center relative shrink-0 h-5 transition-colors duration-[120ms] ease-[cubic-bezier(.32,.72,0,1)] rounded-[5px] px-2 active:scale-[0.98] whitespace-nowrap text-[12px] gap-1 ${isOpen ? "bg-bg-200 text-text-100 dark:bg-[#454540] dark:text-[#ECECEC]" : "text-text-300 hover:text-text-200 hover:bg-bg-200 dark:text-[#B4B4B4] dark:hover:text-[#ECECEC] dark:hover:bg-[#454540]"}`}
            >
                <div className="font-ui inline-flex gap-[3px] text-[14px] h-[14px] leading-none items-baseline">
                    <div className="flex items-center gap-[5px]">
                        {currentModel && <ModelLogo model={currentModel} className="w-3.5 h-3.5" />}
                        <div className="whitespace-nowrap select-none font-medium">
                            {currentModel?.name ?? "Model"}
                        </div>
                        {effortLevels && (
                            <div className="whitespace-nowrap select-none text-text-400">{t[EFFORT_LABEL_KEY[effort]]}</div>
                        )}
                    </div>
                </div>
            </button>

            {isOpen && (
                <div data-mod-menu data-composer-menu role="menu" className="absolute bottom-full right-0 mb-2 w-[320px] bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-50 flex flex-col p-1">
                    <div className="flex items-center gap-0.5 border-b border-bg-300">
                        {tabsOverflow && (
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-hidden
                                disabled={!edges.left}
                                onClick={() => scrollTabs(-1)}
                                className="shrink-0 w-4 h-7 mb-1 flex items-center justify-center rounded-[5px] text-text-300 enabled:hover:text-text-100 disabled:opacity-30"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                        )}
                        {/* The bottom padding holds the open tab's underline, on the divider. The edges fade
                            where more providers hide, instead of the native scrollbar. */}
                        <div
                            ref={tabsRef}
                            onScroll={measureTabs}
                            onWheel={(e) => { if (tabsRef.current && !e.deltaX) tabsRef.current.scrollLeft += e.deltaY; }}
                            style={{ scrollbarWidth: "none", maskImage: tabsMask, WebkitMaskImage: tabsMask }}
                            className="flex min-w-0 flex-1 items-center gap-0.5 pb-1 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
                        >
                            {groups.map((g) => {
                                const on = g.id === group?.id;
                                return (
                                    <button
                                        key={g.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={on}
                                        aria-label={g.name}
                                        onClick={() => setTab(g.id)}
                                        className={`relative shrink-0 w-7 h-7 flex items-center justify-center rounded-[5px] transition-colors ${on ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
                                    >
                                        <ProviderIcon group={g} className="w-4 h-4" />
                                        {on && <span className="absolute left-1.5 right-1.5 -bottom-1 h-[2px] bg-text-100" />}
                                    </button>
                                );
                            })}
                        </div>
                        {tabsOverflow && (
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-hidden
                                disabled={!edges.right}
                                onClick={() => scrollTabs(1)}
                                className="shrink-0 w-4 h-7 mb-1 flex items-center justify-center rounded-[5px] text-text-300 enabled:hover:text-text-100 disabled:opacity-30"
                            >
                                <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => { setIsOpen(false); onConnectProvider?.(); }}
                            aria-label={t.connectProvider}
                            data-tooltip={t.connectProvider}
                            className="shrink-0 w-7 h-7 mb-1 flex items-center justify-center rounded-[5px] text-text-300 hover:text-text-100 hover:bg-bg-200 dark:hover:bg-[#30302E]"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => { setIsOpen(false); onManageModels?.(); }}
                            aria-label={t.manageModels}
                            data-tooltip={t.manageModels}
                            className="shrink-0 w-7 h-7 mb-1 flex items-center justify-center rounded-[5px] text-text-300 hover:text-text-100 hover:bg-bg-200 dark:hover:bg-[#30302E]"
                        >
                            <SlidersHorizontal className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="relative mt-1">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-400" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t.searchModels}
                            className="w-full pl-7 pr-2 py-1 text-[12px] rounded-[5px] bg-bg-200 dark:bg-[#2A2A28] border border-transparent text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
                        />
                    </div>

                    {shown.length > 0 && (
                        <p className="px-2 pt-1.5 pb-0.5 text-[11px] text-text-400">{group?.name}</p>
                    )}
                    <div className="max-h-[300px] overflow-y-auto custom-scrollbar flex flex-col">
                        {shown.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[12px] text-text-400">
                                {models.length === 0 ? t.noActiveModels : t.noResults}
                            </div>
                        ) : (
                            shown.map((model, i) => (
                                <button
                                    key={model.id}
                                    onClick={() => onSelect(model.id)}
                                    className={`w-full text-left px-2 py-1 rounded-[5px] flex items-center justify-between gap-2 group transition-colors hover:bg-bg-200 ${selectedModel === model.id ? "bg-bg-200" : ""}`}
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate text-[13px] leading-5 font-medium text-text-100">{model.name}</span>
                                        {model.badge && (
                                            <span className={`shrink-0 px-1 rounded-[3px] text-[10px] leading-4 font-medium border ${model.badge === "Zen" ? "border-accent/40 text-accent bg-accent/10" : "border-bg-300 text-text-300"}`}>{model.badge}</span>
                                        )}
                                    </div>
                                    <span className="flex shrink-0 items-center gap-2">
                                        {selectedModel === model.id && <Icons.Check className="w-4 h-4 text-accent" />}
                                        {!q && i < 9 && <span className="text-[11px] tabular-nums text-text-400">{i + 1}</span>}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>

                    <div className="mt-1 pt-1 border-t border-bg-300">
                        <p className="flex items-baseline justify-between gap-2 px-2 pt-0.5 pb-1 text-[11px] text-text-400">
                            <span>{t.reasoning}</span>
                            {effortLevels && recommendedEffort && effortLevels.includes(recommendedEffort) && (
                                <span className="truncate">{tMenu.recommended}: {t[EFFORT_LABEL_KEY[recommendedEffort]]}</span>
                            )}
                        </p>
                        {effortLevels ? (
                            <div className="flex flex-wrap gap-0.5 px-1 pb-0.5">
                                {effortLevels.map((lvl) => (
                                    <button
                                        key={lvl}
                                        type="button"
                                        onClick={() => onEffortChange(lvl)}
                                        aria-pressed={effort === lvl}
                                        className={`h-6 px-2 rounded-[5px] text-[12px] transition-colors ${effort === lvl ? "bg-bg-200 text-text-100 ring-1 ring-inset ring-bg-300" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
                                    >
                                        {t[EFFORT_LABEL_KEY[lvl]]}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <p className="px-2 pb-1 text-[12px] text-text-400">{t.noReasoningLevels}</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
