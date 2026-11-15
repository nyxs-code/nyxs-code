import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CHANGELOG, type ChangelogEntry } from "@/lib/changelog";
import { useTranslations } from "@/lib/i18n";

function SectionList({ title, color, items }: { title: string; color: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <p className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>{title}</p>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-snug text-text-200">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-500" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Entry({ entry }: { entry: ChangelogEntry }) {
  const t = useTranslations().changelog;
  return (
    <div className="border-t border-bg-300 pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[13px] font-semibold text-text-100">{entry.date}</h4>
        <span className="text-[11px] font-mono text-text-500">{entry.version}</span>
      </div>
      <div className="mt-2">
        <SectionList title={t.new} color="text-accent" items={entry.added} />
        <SectionList title={t.fixed} color="text-green-400" items={entry.fixed} />
        <SectionList title={t.improved} color="text-blue-400" items={entry.improved} />
      </div>
    </div>
  );
}

export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations().changelog;
  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl max-h-[80vh]">
      <DialogHeader className="px-5 pt-4 pb-3">
        <DialogTitle className="text-[16px]">{t.whatsNew}</DialogTitle>
      </DialogHeader>
      <div className="overflow-y-auto custom-scrollbar px-5 pb-5 space-y-4">
        {CHANGELOG.map((entry) => (
          <Entry key={entry.version} entry={entry} />
        ))}
      </div>
    </Dialog>
  );
}
