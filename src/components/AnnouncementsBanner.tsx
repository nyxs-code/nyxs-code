import { useEffect, useState } from "react";
import { fetchAnnouncements, type Announcement } from "@/lib/telemetry";
import { useTranslations } from "@/lib/i18n";
import { accountKey } from "@/lib/accountScope";
import { NoticeCard } from "@/components/NoticeCard";

const DISMISS_KEY = "nyxs.dismissedAnnouncements.v1";

function dismissedIds(): number[] {
  try {
    return JSON.parse(localStorage.getItem(accountKey(DISMISS_KEY)) || "[]");
  } catch {
    return [];
  }
}

export function AnnouncementsBanner() {
  const t = useTranslations().announcements;
  const [items, setItems] = useState<Announcement[]>([]);

  useEffect(() => {
    let alive = true;
    fetchAnnouncements().then((all) => {
      if (!alive) return;
      const seen = new Set(dismissedIds());
      setItems(all.filter((a) => !seen.has(a.id)));
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!items.length) return null;
  const a = items[0];

  const dismiss = () => {
    localStorage.setItem(accountKey(DISMISS_KEY), JSON.stringify([...dismissedIds(), a.id]));
    setItems((prev) => prev.filter((x) => x.id !== a.id));
  };

  return (
    <div>
      <NoticeCard
        tone={a.level === "warning" ? "warning" : "info"}
        title={a.title}
        body={a.body || undefined}
        closeLabel={t.close}
        onClose={dismiss}
      />
      {items.length > 1 && (
        <p className="mt-1 pr-1 text-right text-[11px] text-text-500">
          {t.moreCount.replace("{count}", String(items.length - 1))}
        </p>
      )}
    </div>
  );
}

export default AnnouncementsBanner;
