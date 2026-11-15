import { ScrollText } from "lucide-react";
import { MarkdownText } from "@/components/Message";
import { useTranslations } from "@/lib/i18n";

export function PlanView({ plan }: { plan: string }) {
  const t = useTranslations().views;
  if (!plan.trim()) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <ScrollText className="w-7 h-7 text-text-500 mb-2" />
        <p className="text-sm text-text-300">{t.noPlan}</p>
        <p className="text-xs text-text-500 mt-1">{t.noPlanDesc}</p>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4 text-text-100">
      <MarkdownText text={plan} />
    </div>
  );
}
