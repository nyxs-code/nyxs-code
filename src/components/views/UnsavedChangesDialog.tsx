import { useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

/** Asks before leaving a file of the Files panel whose changes aren't saved (auto save off).
 *  Cancel and Escape stay on the file. */
export function UnsavedChangesDialog({ name, saving, onSave, onDiscard, onCancel }: {
  name: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations().fileEditor;
  const bodyId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  return (
    // While it saves, Escape can't take it away: the save decides whether the step goes ahead.
    <Dialog open onClose={onCancel} dismissible={!saving} role="alertdialog" describedBy={bodyId} initialFocus={saveRef} className="max-w-sm">
      <DialogHeader close={false}>
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <DialogTitle className="min-w-0 break-words">{t.leaveTitle.replace("{name}", name)}</DialogTitle>
      </DialogHeader>
      <p id={bodyId} className="px-4 text-[13px] leading-relaxed text-text-300">{t.leaveBody}</p>
      <DialogFooter>
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>{t.leaveDiscard}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>{t.cancel}</Button>
        <Button ref={saveRef} variant="primary" onClick={onSave} disabled={saving}>{t.save}</Button>
      </DialogFooter>
    </Dialog>
  );
}
