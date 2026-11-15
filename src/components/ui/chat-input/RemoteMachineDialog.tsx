import { useEffect, useState } from "react";
import { Loader2, Server } from "lucide-react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { describeError } from "@/lib/ipc";
import { connectMachine, saveMachine, savedMachines, sshConfigHosts, useMachineStatus } from "@/lib/remote";

const field = "w-full rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 text-[13px] text-text-100 placeholder:text-text-500 focus:border-accent focus:outline-none";

/** Adds a machine reached over SSH: the host as `ssh` takes it and an optional name. It is
 *  saved once a connection to it works (which installs Nyxs' helper there). */
export function RemoteMachineDialog({ onClose, onAdded }: {
    onClose: () => void;
    onAdded: (host: string) => void;
}) {
    const tr = useTranslations();
    const t = tr.remote;
    const [host, setHost] = useState("");
    const [name, setName] = useState("");
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const status = useMachineStatus(busy ? host.trim() : null);

    useEffect(() => {
        let alive = true;
        const known = new Set(savedMachines().map((m) => m.host));
        void sshConfigHosts().then((list) => { if (alive) setSuggestions(list.filter((h) => !known.has(h))); });
        return () => { alive = false; };
    }, []);

    const connect = async () => {
        const target = host.trim();
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
            await connectMachine(target);
            saveMachine({ host: target, name });
            onAdded(target);
            onClose();
        } catch (e) {
            setError(describeError(e, tr));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open onClose={onClose} stacked className="max-w-lg">
            <DialogHeader>
                <Server className="h-4 w-4 text-accent" />
                <DialogTitle>{t.addTitle}</DialogTitle>
            </DialogHeader>
            <form
                className="space-y-3 px-4 pb-2"
                onSubmit={(e) => { e.preventDefault(); void connect(); }}
            >
                <label className="block">
                    <span className="mb-1 block text-[12.5px] text-text-300">{t.host}</span>
                    <input
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder={t.hostPlaceholder}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className={`${field} font-mono`}
                    />
                    <span className="mt-1 block text-[12px] text-text-400">{t.hostHint}</span>
                </label>
                {suggestions.length > 0 && (
                    <div>
                        <span className="mb-1 block text-[12px] text-text-400">{t.fromConfig}</span>
                        <div className="flex flex-wrap gap-1">
                            {suggestions.map((h) => (
                                <button
                                    key={h}
                                    type="button"
                                    onClick={() => setHost(h)}
                                    className={`rounded-[6px] border px-2 py-0.5 font-mono text-[12px] transition-colors ${host === h ? "border-accent text-text-100" : "border-bg-300 text-text-300 hover:bg-bg-200 hover:text-text-100"}`}
                                >
                                    {h}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <label className="block">
                    <span className="mb-1 block text-[12.5px] text-text-300">{t.name}</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} className={field} />
                </label>
                {busy && (
                    <div className="flex items-center gap-2 text-[12.5px] text-text-300">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {(status.state === "installing" ? t.installing : t.connecting).replace("{host}", host.trim())}
                    </div>
                )}
                {error && (
                    <div className="whitespace-pre-wrap rounded-[6px] border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[12.5px] text-red-500">
                        {error}
                    </div>
                )}
                <button type="submit" hidden />
            </form>
            <DialogFooter>
                <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
                <Button variant="primary" disabled={!host.trim() || busy} onClick={() => void connect()}>
                    {t.connect}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
