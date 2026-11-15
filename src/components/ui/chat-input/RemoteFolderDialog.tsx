import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderPlus, Loader2, Server } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { describeError } from "@/lib/ipc";
import {
    connectMachine,
    createRemoteFolder,
    listRemoteFolders,
    machineLabel,
    parseRemote,
    remoteHome,
    remoteUri,
    useMachineStatus,
} from "@/lib/remote";

/** Connects to a machine (installing Nyxs' helper the first time) and lets the user walk its
 *  folders to pick the project, like the system's folder picker does for this computer. */
export function RemoteFolderDialog({ host, start, onClose, onOpen }: {
    host: string;
    /** `ssh://` folder to start in; the machine's home when missing. */
    start?: string | null;
    onClose: () => void;
    onOpen: (uri: string) => void;
}) {
    const tr = useTranslations();
    const t = tr.remote;
    // Errors are worded with the current language without making the effects re-run on it.
    const trRef = useRef(tr);
    useEffect(() => { trRef.current = tr; }, [tr]);
    const status = useMachineStatus(host);
    const [cwd, setCwd] = useState<string | null>(null);
    // The folders of `of`: a listing for another folder means this one is still loading.
    const [listing, setListing] = useState<{ of: string; folders: string[] } | null>(null);
    const folders = listing && listing.of === cwd ? listing.folders : null;
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    // The name being typed for a new folder; null while not making one.
    const [naming, setNaming] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                await connectMachine(host);
                const first = start && parseRemote(start)?.host === host ? start : await remoteHome(host);
                if (alive) setCwd(first);
            } catch (e) {
                if (alive) setError(describeError(e, trRef.current));
            }
        })();
        return () => { alive = false; };
    }, [host, start, attempt]);

    useEffect(() => {
        if (!cwd) return;
        let alive = true;
        listRemoteFolders(cwd)
            .then((list) => { if (alive) setListing({ of: cwd, folders: list }); })
            .catch((e) => {
                if (!alive) return;
                setListing({ of: cwd, folders: [] });
                setError(describeError(e, trRef.current));
            });
        return () => { alive = false; };
    }, [cwd]);

    const loc = cwd ? parseRemote(cwd) : null;
    const enter = useCallback((name: string) => {
        if (!loc) return;
        setError(null);
        setNaming(null);
        setCwd(remoteUri(host, `${loc.path.replace(/\/+$/, "")}/${name}`));
    }, [host, loc]);
    const up = () => {
        if (!loc) return;
        const parent = loc.path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
        setError(null);
        setNaming(null);
        setCwd(remoteUri(host, /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent));
    };
    /** Makes the typed folder on the machine and goes into it, ready to open. */
    const create = async () => {
        const name = naming?.trim();
        if (!cwd || !name || creating) return;
        setCreating(true);
        setError(null);
        try {
            const made = await createRemoteFolder(cwd, name);
            setNaming(null);
            setCwd(made);
        } catch (e) {
            setError(describeError(e, trRef.current));
        } finally {
            setCreating(false);
        }
    };
    const atRoot = !loc || loc.path === "/" || /^[A-Za-z]:\/?$/.test(loc.path);
    const label = machineLabel(host);
    const busy = !cwd && !error;
    const progress = status.state === "installing" ? t.installing : t.connecting;

    return (
        <Dialog open onClose={onClose} stacked className="max-w-lg">
            <DialogHeader>
                <Server className="h-4 w-4 text-accent" />
                <DialogTitle>{t.pickFolderTitle.replace("{host}", label)}</DialogTitle>
            </DialogHeader>
            <div className="px-4 pb-2">
                {busy && (
                    <div className="flex items-center gap-2 py-6 text-[13px] text-text-300">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {progress.replace("{host}", label)}
                    </div>
                )}
                {error && (
                    <div className="mb-2 whitespace-pre-wrap rounded-[6px] border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[12.5px] text-red-500">
                        {error}
                    </div>
                )}
                {loc && (
                    <>
                        <div className="mb-1.5 flex items-center gap-1.5">
                            <Button icon onClick={up} disabled={atRoot} aria-label={t.up}>
                                <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <span className="min-w-0 flex-1 truncate rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1 font-mono text-[12.5px] text-text-200">
                                {loc.path}
                            </span>
                            <Button onClick={() => setNaming((n) => n ?? "")} disabled={naming !== null}>
                                <FolderPlus className="h-3.5 w-3.5" />
                                {t.newFolder}
                            </Button>
                        </div>
                        <div className="h-72 overflow-y-auto rounded-[6px] border border-bg-300 p-1">
                            {naming !== null && (
                                <form
                                    className="flex items-center gap-2 rounded-[5px] bg-bg-200 px-2 py-0.5 dark:bg-[#30302E]"
                                    onSubmit={(e) => { e.preventDefault(); void create(); }}
                                >
                                    {creating ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-400" /> : <FolderPlus className="h-3.5 w-3.5 shrink-0 text-accent" />}
                                    <input
                                        autoFocus
                                        value={naming}
                                        onChange={(e) => setNaming(e.target.value)}
                                        onKeyDown={(e) => {
                                            // Escape drops the new name, not the whole dialog.
                                            if (e.key === "Escape") { e.stopPropagation(); setNaming(null); }
                                        }}
                                        onBlur={() => { if (!naming.trim() && !creating) setNaming(null); }}
                                        placeholder={t.newFolderPlaceholder}
                                        aria-label={t.newFolderPlaceholder}
                                        spellCheck={false}
                                        disabled={creating}
                                        className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] text-text-100 placeholder:text-text-500 focus:outline-none"
                                    />
                                </form>
                            )}
                            {folders === null ? (
                                <div className="flex items-center gap-2 px-2 py-2 text-[12.5px] text-text-400">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                </div>
                            ) : folders.length === 0 && naming === null ? (
                                <div className="px-2 py-2 text-[12.5px] text-text-400">{t.emptyFolder}</div>
                            ) : (
                                folders.map((name) => (
                                    <button
                                        key={name}
                                        type="button"
                                        onClick={() => enter(name)}
                                        className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[13px] text-text-100 transition-colors hover:bg-bg-200 dark:hover:bg-[#30302E]"
                                    >
                                        <Folder className={`h-3.5 w-3.5 shrink-0 ${name.startsWith(".") ? "text-text-500" : "text-text-400"}`} />
                                        <span className="truncate">{name}</span>
                                    </button>
                                ))
                            )}
                        </div>
                    </>
                )}
            </div>
            <DialogFooter>
                {error && !cwd && <Button variant="ghost" className="mr-auto" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>{t.retry}</Button>}
                <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
                <Button variant="primary" disabled={!cwd} onClick={() => { if (cwd) { onOpen(cwd); onClose(); } }}>
                    {t.openFolder}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
