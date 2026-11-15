import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

export function OpenProjectModal({
  onOpen,
  onCancel,
}: {
  onOpen: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations().modals;
  return (
    <Dialog open onClose={onCancel}>
      <DialogHeader>
        <FolderOpen className="w-4 h-4 text-accent" />
        <DialogTitle>{t.openProjectTitle}</DialogTitle>
      </DialogHeader>
      <p className="px-4 text-[13px] text-text-300 leading-relaxed">{t.openProjectDesc}</p>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{t.cancel}</Button>
        <Button variant="primary" onClick={onOpen}>{t.openFolder}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export default OpenProjectModal;
