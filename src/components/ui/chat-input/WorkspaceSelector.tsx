import React, { useState, useRef, useEffect } from "react";
import { Check, Folder, FolderOpen, Layers, Plus, Settings2, X } from "lucide-react";
import { workspaceName } from "@/lib/workspace";
import { useTranslations } from "@/lib/i18n";
import { applyEnvironment, savedEnvironments, setPendingEnvironment, usePendingEnvironment, useSavedEnvironments, type SavedEnvironment } from "@/lib/environments";
import { EnvironmentDialog } from "./EnvironmentDialog";
import { BranchMenuRow } from "@/components/branch/BranchMenuRow";
import { useBranchPicker } from "@/components/branch/useBranchPicker";

export const WorkspaceSelector: React.FC<{
    workspace?: string | null;
    recentWorkspaces: string[];
    onSelect?: (path: string) => void;
    onClose?: (path: string) => void;
    onPick?: () => void;
}> = ({ workspace, recentWorkspaces, onSelect, onClose, onPick }) => {
    const t = useTranslations().chatInput;
    const te = useTranslations().environments;
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const environments = useSavedEnvironments();
    const pendingId = usePendingEnvironment();
    // The environment picked for the next session, while its folder is still the open one.
    const current = environments.find((e) => e.id === pendingId && e.folder === workspace) ?? null;
    const [editing, setEditing] = useState<{ env: SavedEnvironment | null } | null>(null);
    // The folder's branch lives in this menu, as in Claude Code Desktop's new session.
    const branch = useBranchPicker(current ? null : workspace, ref);

    useEffect(() => {
        const handle = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, []);

    // Like Claude Code Desktop on the new-session screen: Ctrl+Alt+1–9 picks an environment,
    // Ctrl+Alt+0 opens New environment. This selector only shows there.
    const pickRef = useRef<(env: SavedEnvironment) => void>(() => {});
    useEffect(() => { pickRef.current = (env) => applyEnvironment(env, (p) => onSelect?.(p)); });
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return;
            const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
            if (digit === undefined) return;
            // AltGr arrives as Ctrl+Alt on Windows and types @ # | with these keys: that's text,
            // never the shortcut. Cmd+Option on macOS types nothing.
            if (!e.metaKey && (e.getModifierState?.("AltGraph") || (e.key.length === 1 && e.key !== digit))) return;
            if (digit === "0") {
                e.preventDefault();
                setEditing({ env: null });
                return;
            }
            const env = savedEnvironments()[Number(digit) - 1];
            if (!env) return;
            e.preventDefault();
            pickRef.current(env);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const items = workspace && !recentWorkspaces.includes(workspace)
        ? [workspace, ...recentWorkspaces]
        : recentWorkspaces;
    const row = "group w-full flex items-center gap-1 pl-2 pr-0.5 py-0.5 rounded-[5px] transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]";
    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => (items.length === 0 && environments.length === 0 ? onPick?.() : setOpen((o) => !o))}
                className={`inline-flex items-center gap-1.5 max-w-[220px] h-6 px-1.5 rounded-[5px] text-[12px] transition-colors ${open ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
                type="button"
            >
                {current ? <Layers className="w-3.5 h-3.5 shrink-0 text-accent" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
                <span className="truncate">{current ? current.name : workspace ? workspaceName(workspace) : t.chooseFolder}</span>
            </button>
            {open && (
                <div data-mod-menu data-composer-menu role="menu" className="absolute bottom-full left-0 mb-2 w-72 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-50 p-1">
                    {environments.length > 0 && (
                        <>
                            <div className="px-2 pt-0.5 pb-1 text-[12px] text-text-400">{te.title}</div>
                            {environments.map((env, i) => (
                                <div key={env.id} className={row}>
                                    <button
                                        onClick={() => { applyEnvironment(env, (p) => onSelect?.(p)); setOpen(false); }}
                                        className="flex-1 min-w-0 flex items-center gap-2 text-left"
                                        type="button"
                                    >
                                        <Layers className={`w-3.5 h-3.5 shrink-0 ${current?.id === env.id ? "text-accent" : "text-text-400"}`} />
                                        <span className="min-w-0 truncate text-[13px] leading-5 text-text-100">{env.name}</span>
                                        <span className="min-w-0 truncate text-[11.5px] text-text-400">{workspaceName(env.folder)}</span>
                                    </button>
                                    {i < 9 && <span className="shrink-0 text-[11px] tabular-nums text-text-500">Ctrl+Alt+{i + 1}</span>}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setEditing({ env }); setOpen(false); }}
                                        aria-label={te.editTitle}
                                        className="shrink-0 p-0.5 rounded-[4px] text-text-400 opacity-0 group-hover:opacity-100 hover:text-text-100 hover:bg-bg-300 transition-all"
                                        type="button"
                                    >
                                        <Settings2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                            <div className="my-1 h-px bg-bg-300 dark:bg-[#30302E]" />
                        </>
                    )}
                    {items.length > 0 && (
                        <div className="px-2 pt-0.5 pb-1 text-[12px] text-text-400">{t.recentWorkspaces}</div>
                    )}
                    {items.map((path) => {
                        const active = path === workspace && !current;
                        return (
                            <div key={path} className={row}>
                                <button
                                    onClick={() => { setPendingEnvironment(null); onSelect?.(path); setOpen(false); }}
                                    className="flex-1 min-w-0 flex items-center gap-2 text-left"
                                    type="button"
                                >
                                    <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${active ? "text-accent" : "text-text-400"}`} />
                                    <span className="text-[13px] leading-5 text-text-100 truncate">{workspaceName(path)}</span>
                                </button>
                                {active && <Check className="w-4 h-4 text-accent shrink-0" />}
                                <button
                                    onClick={(e) => { e.stopPropagation(); onClose?.(path); }}
                                    data-tooltip={t.removeItem}
                                    className="shrink-0 p-0.5 rounded-[4px] text-text-400 opacity-0 group-hover:opacity-100 hover:text-text-100 hover:bg-bg-300 transition-all"
                                    type="button"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        );
                    })}
                    {items.length > 0 && <div className="my-1 h-px bg-bg-300 dark:bg-[#30302E]" />}
                    <button
                        onClick={() => { setPendingEnvironment(null); onPick?.(); setOpen(false); }}
                        className="w-full text-left px-2 py-0.5 rounded-[5px] flex items-center gap-2 transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]"
                        type="button"
                    >
                        <Folder className="w-3.5 h-3.5 text-text-400 shrink-0" />
                        <span className="text-[13px] leading-5 text-text-100">{t.chooseFolder}</span>
                    </button>
                    <button
                        onClick={() => { setEditing({ env: null }); setOpen(false); }}
                        className="w-full text-left px-2 py-0.5 rounded-[5px] flex items-center gap-2 transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]"
                        type="button"
                    >
                        <Plus className="w-3.5 h-3.5 text-text-400 shrink-0" />
                        <span className="flex-1 text-[13px] leading-5 text-text-100">{te.newEnvironment}</span>
                        <span className="text-[11px] tabular-nums text-text-500">Ctrl+Alt+0</span>
                    </button>
                    {branch.data && workspace && (
                        <>
                            <div className="my-1 h-px bg-bg-300 dark:bg-[#30302E]" />
                            <BranchMenuRow picker={branch} folder={workspaceName(workspace)} onPicked={() => setOpen(false)} />
                        </>
                    )}
                </div>
            )}
            {branch.overlays}
            {editing && (
                <EnvironmentDialog
                    env={editing.env}
                    defaultFolder={workspace ?? null}
                    onClose={() => setEditing(null)}
                    onSaved={(env) => { if (!editing.env) applyEnvironment(env, (p) => onSelect?.(p)); }}
                />
            )}
        </div>
    );
};
