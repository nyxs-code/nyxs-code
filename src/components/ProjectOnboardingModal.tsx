import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";

export function ProjectOnboardingModal({
  name,
  onCreate,
  onDismiss,
}: {
  name: string;
  onCreate: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations().modals;
  return (
    <Dialog open onClose={onDismiss}>
      <DialogHeader>
        <Sparkles className="w-4 h-4 text-accent" />
        <DialogTitle>{t.onboardingTitle}</DialogTitle>
      </DialogHeader>
      <p className="px-4 text-[13px] text-text-300 leading-relaxed">
        {t.onboardingDesc.replace("{name}", name)}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onDismiss}>{t.onboardingDismiss}</Button>
        <Button variant="primary" onClick={onCreate}>{t.onboardingCreate}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export default ProjectOnboardingModal;
