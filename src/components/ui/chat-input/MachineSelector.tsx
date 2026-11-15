import React, { useEffect, useRef, useState } from "react";
import { Check, Laptop, Loader2, Plus, Server, X } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { isRemotePath, machineLabel, remoteHostOf, removeMachine, useMachineStatus, useSavedMachines } from "@/lib/remote";
import { RemoteMachineDialog } from "./RemoteMachineDialog";

/** The dot after a remote machine's name: connecting, connected or failed. */
function StatusMark({ host }: { host: string }) {
    const s = useMachineStatus(host);
    if (s.state === "connecting" || s.state === "installing") return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-text-400" />;
    if (s.state === "error" || s.state === "disconnected") return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />;
    if (s.state === "connected") return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />;
    return null;
}

/** Where a new session works: this computer or a machine reached over SSH. Picking a machine
 *  opens its folder picker; the folder chosen there becomes the workspace (`ssh://host/path`). */
export const MachineSelector: React.FC<{
    workspace?: string | null;
    recentWorkspaces: string[];
    onSelect?: (path: string) => void;
    onPickLocal?: () => void;
    /** Opens the remote folder picker for a machine, starting in `start` (owned by the composer
     *  so the folder chip can open it too). */
    onPickRemote: (host: string, start?: string | null) => void;
}> = ({ workspace, recentWorkspaces, onSelect, onPickLocal, onPickRemote }) => {
    const t = useTranslations().remote;
    const [open, setOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const machines = useSavedMachines();
    const host = remoteHostOf(workspace);

    useEffect(() => {
        const handle = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, []);

    const pickLocal = () => {
        setOpen(false);
        if (!host) return;
        const last = recentWorkspaces.find((p) => !isRemotePath(p));
        if (last) onSelect?.(last);
        else onPickLocal?.();
    };
    const pickMachine = (h: string) => {
        setOpen(false);
        if (h === host) return;
        onPickRemote(h, recentWorkspaces.find((p) => remoteHostOf(p) === h) ?? null);
    };
    const row = "group w-full flex items-center gap-2 pl-2 pr-0.5 py-0.5 rounded-[5px] text-left transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]";

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={`inline-flex items-center gap-1.5 max-w-[180px] h-6 px-1.5 rounded-[5px] text-[12px] transition-colors ${open ? "bg-bg-200 text-text-100" : "text-text-300 hover:text-text-100 hover:bg-bg-200"}`}
            >
                {host ? <Server className="w-3.5 h-3.5 shrink-0" /> : <Laptop className="w-3.5 h-3.5 shrink-0" />}
                <span className="truncate">{host ? machineLabel(host) : t.local}</span>
                {host && <StatusMark host={host} />}
            </button>
            {open && (
                <div data-mod-menu data-composer-menu role="menu" className="absolute bottom-full left-0 mb-2 w-64 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-50 p-1">
                    <div className="px-2 pt-0.5 pb-1 text-[12px] text-text-400">{t.where}</div>
                    <button type="button" onClick={pickLocal} className={`${row} pr-2`}>
                        <Laptop className={`w-3.5 h-3.5 shrink-0 ${host ? "text-text-400" : "text-accent"}`} />
                        <span className="flex-1 text-[13px] leading-5 text-text-100">{t.thisPc}</span>
                        {!host && <Check className="w-4 h-4 text-accent shrink-0" />}
                    </button>
                    {machines.length > 0 && (
                        <>
                            <div className="my-1 h-px bg-bg-300 dark:bg-[#30302E]" />
                            <div className="px-2 pt-0.5 pb-1 text-[12px] text-text-400">{t.machines}</div>
                        </>
                    )}
                    {machines.map((m) => (
                        <div key={m.host} className={row}>
                            <button type="button" onClick={() => pickMachine(m.host)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                                <Server className={`w-3.5 h-3.5 shrink-0 ${m.host === host ? "text-accent" : "text-text-400"}`} />
                                <span className="min-w-0 truncate text-[13px] leading-5 text-text-100">{m.name || m.host}</span>
                                {m.name && <span className="min-w-0 truncate font-mono text-[11.5px] text-text-400">{m.host}</span>}
                                <StatusMark host={m.host} />
                            </button>
                            {m.host === host && <Check className="w-4 h-4 text-accent shrink-0" />}
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); removeMachine(m.host); }}
                                aria-label={t.remove}
                                className="shrink-0 p-0.5 rounded-[4px] text-text-400 opacity-0 group-hover:opacity-100 hover:text-text-100 hover:bg-bg-300 transition-all"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}
                    <div className="my-1 h-px bg-bg-300 dark:bg-[#30302E]" />
                    <button type="button" onClick={() => { setOpen(false); setAdding(true); }} className={`${row} pr-2`}>
                        <Plus className="w-3.5 h-3.5 shrink-0 text-text-400" />
                        <span className="text-[13px] leading-5 text-text-100">{t.addMachine}</span>
                    </button>
                </div>
            )}
            {adding && <RemoteMachineDialog onClose={() => setAdding(false)} onAdded={(h) => onPickRemote(h, null)} />}
        </div>
    );
};
