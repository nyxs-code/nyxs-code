import { Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";

/** What a CLI's panel is waiting for: an install running quietly, or a terminal the user is
 *  signing in from. */
export function WaitingNote({ waiting, terminalText }: { waiting: "install" | "login"; terminalText: string }) {
  const t = useTranslations().settings.agents;
  return (
    <p className="text-[12px] text-text-300 inline-flex items-center gap-2">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {waiting === "install" ? t.installing : terminalText}
    </p>
  );
}
