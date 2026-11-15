import { useEffect, useRef, useState } from "react";
import { X, Loader2, Check, Paperclip } from "lucide-react";
import { sendFeedback } from "@/lib/telemetry";
import { getSession } from "@/lib/auth";
import { useTranslations } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogTitle } from "@/components/ui/dialog";

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1400;
        let { width, height } = img;
        if (width > max || height > max) {
          const s = max / Math.max(width, height);
          width = Math.round(width * s);
          height = Math.round(height * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no-canvas"));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => reject(new Error("bad-image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
}

type TypeId = "bug" | "feature" | "billing" | "general";
const TYPE_IDS: TypeId[] = ["bug", "feature", "billing", "general"];

const DESC_MIN = 50;
const STEPS_MIN = 20;
const MAX = 4000;

export function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fb = useTranslations().feedback;
  const TYPE_META: Record<TypeId, { label: string; placeholder: string }> = {
    bug: { label: fb.typeBug, placeholder: fb.bugPlaceholder },
    feature: { label: fb.typeFeature, placeholder: fb.featurePlaceholder },
    billing: { label: fb.typeBilling, placeholder: fb.billingPlaceholder },
    general: { label: fb.typeGeneral, placeholder: fb.generalPlaceholder },
  };
  const [type, setType] = useState<TypeId>("bug");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [includeDiag, setIncludeDiag] = useState(true);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setType("bug");
      setDescription("");
      setSteps("");
      setIncludeDiag(true);
      setScreenshot(null);
      setState("idle");
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    void getSession().then((u) => setEmail(u?.email ?? ""));
  }, [open]);

  if (!open) return null;

  const current = TYPE_META[type];
  const isBug = type === "bug";
  const descOk = description.trim().length >= DESC_MIN;
  const stepsOk = !isBug || steps.trim().length >= STEPS_MIN;
  const canSubmit = descOk && stepsOk && state !== "sending";

  const submit = async () => {
    if (!canSubmit) return;
    setState("sending");
    setError(null);
    let msg = `[${current.label}]\n\n${description.trim()}`;
    if (isBug && steps.trim()) msg += `\n\n${fb.reproPrefix}\n${steps.trim()}`;
    if (includeDiag) {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      msg += `\n\n${fb.diagLabel}\n${ua}`;
    }
    try {
      await sendFeedback(msg.slice(0, MAX), 0, screenshot ?? undefined);
      setState("done");
      setTimeout(onClose, 1600);
    } catch (e) {
      setError((e as Error).message || fb.errSend);
      setState("idle");
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(fb.errImageType);
      return;
    }
    try {
      setScreenshot(await compressImage(file));
      setError(null);
    } catch {
      setError(fb.errImageProcess);
    }
  };

  return (
    // A click outside must not throw away what was typed: only the thank-you closes that way.
    // Escape still closes the form, so the wrapper handles it while the dialog isn't dismissible
    // (the wrapper takes the focus on a click on the panel's text, so Escape always reaches it).
    <Dialog
      open
      onClose={onClose}
      stacked
      dismissible={state === "done"}
      label={state === "done" ? fb.thanksTitle : undefined}
      initialFocus={descriptionRef}
      className="max-w-2xl"
    >
      <div
        tabIndex={-1}
        className="flex min-h-0 flex-col outline-none"
        onKeyDown={(e) => {
          if (e.key === "Escape" && state !== "done") {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }
        }}
      >
        {state === "done" ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15">
              <Check className="h-6 w-6 text-accent" />
            </span>
            <p className="text-base font-medium text-text-100">{fb.thanksTitle}</p>
            <p className="text-sm text-text-400">{fb.thanksDesc}</p>
          </div>
        ) : (
          <>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-bg-300 px-6 py-4">
              <DialogTitle className="text-base font-semibold">{fb.title}</DialogTitle>
              <Button variant="ghost" icon data-dialog-close onClick={onClose} aria-label={fb.close} className="-mr-1.5">
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div className="min-h-0 overflow-y-auto custom-scrollbar px-6 py-5 space-y-5">
              <div>
                <p className="mb-2 text-sm font-semibold text-text-200">{fb.typeLabel}</p>
                <div className="space-y-1.5">
                  {TYPE_IDS.map((id) => (
                    <label key={id} className="flex cursor-pointer items-center gap-2.5 text-sm text-text-100">
                      <input
                        type="radio"
                        name="fbtype"
                        checked={type === id}
                        onChange={() => setType(id)}
                        className="accent-accent"
                      />
                      {TYPE_META[id].label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-semibold text-text-200">{fb.description}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-400">
                  {fb.descriptionHelp}
                </p>
                <ul className="mb-2 mt-1 list-disc pl-5 text-[13px] text-text-400 space-y-0.5">
                  <li>{fb.hintRepro}</li>
                  <li>{fb.hintExpected}</li>
                  <li>{fb.hintActual}</li>
                  <li>{fb.hintErrors}</li>
                  <li>{fb.hintRelevant}</li>
                </ul>
                <textarea
                  ref={descriptionRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, MAX))}
                  rows={5}
                  placeholder={current.placeholder}
                  className="w-full resize-none rounded-[6px] border border-bg-300 bg-bg-0 px-3 py-2.5 text-sm text-text-100 outline-none placeholder:text-text-500 focus:border-accent transition-colors"
                />
                <div className={`mt-1 text-right text-[11px] ${descOk ? "text-text-500" : "text-red-400"}`}>
                  {description.trim().length}/{DESC_MIN}
                </div>
              </div>

              {isBug && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold text-text-200">{fb.stepsLabel}</p>
                  <textarea
                    value={steps}
                    onChange={(e) => setSteps(e.target.value.slice(0, MAX))}
                    rows={4}
                    placeholder={fb.stepsPlaceholder}
                    className="w-full resize-none rounded-[6px] border border-bg-300 bg-bg-0 px-3 py-2.5 text-sm text-text-100 outline-none placeholder:text-text-500 focus:border-accent transition-colors"
                  />
                  <div className={`mt-1 text-right text-[11px] ${stepsOk ? "text-text-500" : "text-red-400"}`}>
                    {steps.trim().length}/{STEPS_MIN}
                  </div>
                </div>
              )}

              <div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
                {screenshot ? (
                  <div className="relative inline-block">
                    <img src={screenshot} alt={fb.screenshotAlt} className="max-h-40 rounded border border-bg-300" />
                    <button
                      onClick={() => setScreenshot(null)}
                      className="absolute -right-2 -top-2 rounded-full bg-bg-300 p-1 text-text-200 hover:bg-bg-200"
                      aria-label={fb.removeScreenshot}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-2 text-sm text-text-300 hover:text-text-100 transition-colors"
                  >
                    <Paperclip className="h-4 w-4" />
                    {fb.attach}
                  </button>
                )}
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-text-200">
                <input type="checkbox" checked={includeDiag} onChange={(e) => setIncludeDiag(e.target.checked)} className="accent-accent" />
                {fb.includeDiag}
              </label>
              {email && <p className="text-[13px] text-text-400">{fb.sentAs.replace("{email}", email)}</p>}

              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>

            <DialogFooter className="border-t border-bg-300 px-6 py-3">
              <Button variant="ghost" onClick={onClose}>
                {fb.cancel}
              </Button>
              <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
                {state === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {state === "sending" ? fb.sending : fb.send}
              </Button>
            </DialogFooter>
          </>
        )}
      </div>
    </Dialog>
  );
}

export default FeedbackModal;
