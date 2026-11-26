import { useState } from "react";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n";
import { SearchBox } from "./ui";

/** Every tool of a connector, with a search, as Claude's "Show all" opens them. */
export function ConnectorToolsDialog({
  name,
  tools,
  open,
  onClose,
}: {
  name: string;
  tools: string[];
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations().customizePage;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? tools.filter((x) => x.toLowerCase().includes(q)) : tools;
  return (
    <Dialog open={open} onClose={onClose} className="max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{t.toolsOf.replace("{name}", name)}</DialogTitle>
      </DialogHeader>
      <div className="px-4 pt-1">
        <SearchBox value={query} onChange={setQuery} placeholder={t.searchTools} size="lg" autoFocus />
        <div className="mt-3 max-h-[360px] overflow-y-auto custom-scrollbar">
          {shown.length > 0 ? (
            <ul className="grid grid-cols-2 gap-x-6 gap-y-2 pb-2">
              {shown.map((tool) => (
                <li key={tool} className="min-w-0 break-words text-[14px] text-text-100">
                  {tool}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-text-400">{t.noToolsMatch}</p>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t.done}</Button>
      </DialogFooter>
    </Dialog>
  );
}
