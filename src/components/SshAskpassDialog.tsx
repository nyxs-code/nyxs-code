import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";

/** A question `ssh` asks while connecting to a machine (src-tauri/src/remote/askpass.rs). */
export interface AskpassRequest {
  id: number;
  host: string;
  /** What ssh printed: "dev@server's password:". */
  prompt: string;
  kind: "password" | "passphrase" | "confirm";
  /** The previous answer to this question was wrong. */
  retry: boolean;
}

const field = "w-full rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 text-[13px] text-text-100 placeholder:text-text-500 focus:border-accent focus:outline-none";

const answer = (id: number, value: string | null, remember = false) =>
  invoke("ssh_askpass_answer", { id, value, remember }).catch(() => undefined);

/** Asks the user for what ssh needs to sign in to a remote machine: a password, a key's
 *  passphrase, or a yes/no question. One question at a time, in the order ssh asked them.
 *  What is typed goes only to ssh, unless "Remember" is ticked (then to the system keychain). */
export function SshAskpassDialog() {
  const [queue, setQueue] = useState<AskpassRequest[]>([]);

  useEffect(() => {
    const asked = listen<AskpassRequest>("ssh-askpass", ({ payload }) => setQueue((q) => [...q, payload]));
    // The backend stopped waiting (ssh gave up): the dialog goes.
    const closed = listen<number>("ssh-askpass-closed", ({ payload }) => setQueue((q) => q.filter((r) => r.id !== payload)));
    return () => {
      void asked.then((f) => f());
      void closed.then((f) => f());
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const done = (value: string | null, remember?: boolean) => {
    void answer(current.id, value, remember);
    setQueue((q) => q.slice(1));
  };
  // A new key per question, so the field starts empty.
  return <AskpassPanel key={current.id} request={current} onAnswer={done} />;
}

function AskpassPanel({ request, onAnswer }: { request: AskpassRequest; onAnswer: (value: string | null, remember?: boolean) => void }) {
  const tr = useTranslations();
  const t = tr.remote;
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const cancel = () => onAnswer(null);

  if (request.kind === "confirm") {
    return (
      <Dialog open onClose={cancel} role="alertdialog" stacked className="max-w-md" describedBy="askpass-question">
        <DialogHeader close={false}>
          <KeyRound className="h-4 w-4 text-accent" />
          <DialogTitle>{t.askpassConfirmTitle.replace("{host}", request.host)}</DialogTitle>
        </DialogHeader>
        <p id="askpass-question" className="whitespace-pre-wrap px-4 pb-2 text-[13px] text-text-200">{request.prompt}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onAnswer("no")}>{t.askpassNo}</Button>
          <Button variant="primary" onClick={() => onAnswer("yes")}>{t.askpassYes}</Button>
        </DialogFooter>
      </Dialog>
    );
  }

  const passphrase = request.kind === "passphrase";
  const label = passphrase ? t.askpassPassphrase : t.askpassPassword;
  return (
    <Dialog open onClose={cancel} stacked className="max-w-md" describedBy="askpass-prompt">
      <DialogHeader>
        <KeyRound className="h-4 w-4 text-accent" />
        <DialogTitle>{(passphrase ? t.askpassPassphraseTitle : t.askpassTitle).replace("{host}", request.host)}</DialogTitle>
      </DialogHeader>
      <form
        className="space-y-3 px-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onAnswer(value, remember);
        }}
      >
        <p id="askpass-prompt" className="break-words font-mono text-[12px] text-text-400">{request.prompt}</p>
        {request.retry && (
          <div role="alert" className="rounded-[6px] border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[12.5px] text-red-500">
            {t.askpassWrong}
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-text-300">{label}</span>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={field}
          />
        </label>
        <label className="flex items-start gap-2 text-[12.5px] text-text-200">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5" />
          <span>
            {t.askpassRemember}
            <span className="block text-[12px] text-text-400">{t.askpassRememberHint}</span>
          </span>
        </label>
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={cancel}>{t.cancel}</Button>
        <Button variant="primary" disabled={!value} onClick={() => onAnswer(value, remember)}>{t.askpassContinue}</Button>
      </DialogFooter>
    </Dialog>
  );
}
