import { useEffect, useRef, useState, type ComponentType } from "react";
import { BookOpen, BookText, ChevronRight, ExternalLink, FileText, Keyboard, Newspaper, Rocket, ShieldCheck } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/openExternal";
import { GITHUB_REPO_URL, siteUrl } from "@/lib/siteLinks";
import { cn } from "@/lib/utils";

/** lucide-react dropped its brand icons, so the GitHub mark is drawn here. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * "Learn more" row of the account menu: a submenu, opened on hover like the language one, with
 * the nyxs.dev pages (in the app's language) and the GitHub repo, all opened in the system browser.
 */
export function LearnMoreMenu({ language, close }: { language: string; close: () => void }) {
  const t = useTranslations().sidebar;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    timer.current = window.setTimeout(() => setOpen(false), 200);
  };
  const go = (url: string) => {
    openExternalUrl(url);
    setOpen(false);
    close();
  };

  const links: { icon: ComponentType<{ className?: string }>; label: string; url: string }[][] = [
    [
      { icon: BookText, label: t.linkDocs, url: siteUrl("docs", language) },
      { icon: Rocket, label: t.linkQuickstart, url: siteUrl("quickstart", language) },
      { icon: Keyboard, label: t.linkShortcuts, url: siteUrl("shortcuts", language) },
      { icon: Newspaper, label: t.linkBlog, url: siteUrl("blog", language) },
      { icon: GitHubMark, label: "GitHub", url: GITHUB_REPO_URL },
    ],
    [
      { icon: ShieldCheck, label: t.linkPrivacy, url: siteUrl("privacy", language) },
      { icon: FileText, label: t.linkTerms, url: siteUrl("terms", language) },
    ],
  ];

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        onClick={show}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 transition-colors",
          open ? "bg-bg-200" : "hover:bg-bg-200",
        )}
      >
        <BookOpen className="w-4 h-4 text-text-300 shrink-0" />
        <span className="flex-1 text-left">{t.learnMore}</span>
        <ChevronRight className="w-3.5 h-3.5 text-text-400" />
      </button>
      {open && (
        <div
          data-mod-menu
          role="menu"
          onMouseEnter={show}
          onMouseLeave={hide}
          className="absolute left-full bottom-0 ml-1 w-60 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-[70] p-1.5"
        >
          {links.map((group, i) => (
            <div key={i}>
              {i > 0 && <div className="h-px bg-bg-300 my-1" />}
              {group.map(({ icon: Icon, label, url }) => (
                <button
                  key={url}
                  role="menuitem"
                  onClick={() => go(url)}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
                >
                  <Icon className="w-4 h-4 text-text-300 shrink-0" />
                  <span className="flex-1 text-left truncate">{label}</span>
                  <ExternalLink className="w-3.5 h-3.5 text-text-500 shrink-0" />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
