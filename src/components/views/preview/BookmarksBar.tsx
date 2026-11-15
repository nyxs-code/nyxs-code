import { useState } from "react";
import { Globe } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { removeBookmark, type Bookmark } from "@/lib/browserBookmarks";
import { useCloseOnBlur } from "@/lib/useCloseOnBlur";

/** The bookmarks bar under the address bar: each saved page with its icon and title. A click
 *  opens it in this tab; the right button offers to remove it. */
export function BookmarksBar({ bookmarks, onOpen }: { bookmarks: Bookmark[]; onOpen: (url: string) => void }) {
  const t = useTranslations().views;
  const [menu, setMenu] = useState<{ url: string; x: number } | null>(null);
  useCloseOnBlur(!!menu, () => setMenu(null));
  if (!bookmarks.length) return null;
  return (
    <div className="relative">
      <div role="toolbar" aria-label={t.bookmarksBar} className="flex items-center gap-0.5 px-2 pb-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {bookmarks.map((b) => (
          <button
            key={b.url}
            type="button"
            onClick={() => onOpen(b.url)}
            onContextMenu={(e) => {
              e.preventDefault();
              const bar = e.currentTarget.parentElement!.getBoundingClientRect();
              setMenu({ url: b.url, x: e.clientX - bar.left });
            }}
            className="shrink-0 inline-flex max-w-[11rem] items-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[12px] text-text-200 hover:bg-bg-200 hover:text-text-100 transition-colors"
          >
            <BookmarkIcon icon={b.icon} />
            <span className="truncate">{b.title || b.url}</span>
          </button>
        ))}
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} aria-hidden />
          <div role="menu" data-webview-hole className="absolute top-full z-50 mt-0.5 min-w-[10rem] rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg" style={{ left: menu.x }}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                removeBookmark(menu.url);
                setMenu(null);
              }}
              className="w-full rounded-[6px] px-2 py-1 text-left text-[13px] text-text-100 hover:bg-bg-200"
            >
              {t.removeBookmark}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function BookmarkIcon({ icon }: { icon: string }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) return <Globe className="w-3.5 h-3.5 shrink-0 text-text-400" aria-hidden />;
  return <img src={icon} alt="" className="w-3.5 h-3.5 shrink-0 rounded-sm object-contain" onError={() => setFailed(true)} />;
}

