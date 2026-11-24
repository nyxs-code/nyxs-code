import type { RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { invoke } from "@/lib/ipc";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { PREVIEW_ORIGIN, type Bounds } from "@/lib/previewWebview";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useSettings } from "@/lib/useSettings";
import {
  VIEWPORT_SIZES,
  setBrowserPrefs,
  useBrowserPrefs,
  type CookieMode,
  type Viewport,
} from "@/lib/browserPrefs";
import { MenuItem, MenuSep } from "./MenuItem";
import type { SubMenu } from "./useBrowserMenu";
import type { LoadTarget } from "./usePageAddress";

/** The browser settings menu (⋮): open elsewhere, copy, screenshot, viewport, cookies. */
export function BrowserMenu({
  menuRef,
  sub,
  setSub,
  subLeft,
  openSub,
  setMenuOpen,
  notify,
  workspace,
  input,
  extUrl,
  tabId,
  hasPage,
  openInLabel,
  contentBounds,
  loadTarget,
  reload,
  onImportCookies,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  sub: SubMenu | null;
  setSub: (sub: SubMenu | null) => void;
  subLeft: boolean;
  openSub: (which: SubMenu) => void;
  setMenuOpen: (open: boolean) => void;
  notify: (msg: string) => void;
  workspace: string | null;
  input: string;
  extUrl: string;
  /** The tab, whose own webview draws a website for the screenshot. */
  tabId: string;
  hasPage: boolean;
  openInLabel: string;
  contentBounds: () => Bounds | null;
  loadTarget: LoadTarget;
  reload: () => void;
  /** Opens "Import cookies" (CookieImportDialog), which outlives this menu. */
  onImportCookies: () => void;
}) {
  const t = useTranslations().views;
  const tc = useTranslations().cookieImport;
  const prefs = useBrowserPrefs();
  const { settings, update } = useSettings();
  const verifyChanges = (settings as { allowPreview?: boolean }).allowPreview ?? true;

  const isHttp = /^https?:\/\//i.test(input);
  const openExternal = () => { if (isHttp) invoke("agent_open_external", { url: input }).catch(() => {}); setMenuOpen(false); };

  const copyUrl = () => {
    setMenuOpen(false);
    void navigator.clipboard.writeText(extUrl || input).then(() => notify(t.urlCopied), () => {});
  };

  const saveScreenshot = async () => {
    setMenuOpen(false);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const path = await saveDialog({ defaultPath: `nyxs-${stamp}.png`, filters: [{ name: "PNG", extensions: ["png"] }] }).catch(() => null);
    if (!path) return;
    // Let the dialog go away and the page show again before taking the picture.
    await new Promise((r) => setTimeout(r, 350));
    const b = contentBounds();
    if (!b) return;
    try {
      await invoke("preview_capture", { ...b, path, tab: extUrl ? tabId : null });
      notify(t.screenshotSaved);
    } catch (e) {
      notify(`${t.screenshotFailed}: ${localizedError(e)}`);
    }
  };

  const openHtmlFile = async () => {
    setMenuOpen(false);
    const picked = await openDialog({
      multiple: false,
      directory: false,
      defaultPath: workspace ?? undefined,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    }).catch(() => null);
    if (typeof picked !== "string") return;
    await invoke("agent_allow_ui_path", { path: picked.replace(/[\\/][^\\/]*$/, "") }).catch(() => {});
    await loadTarget(picked, true);
  };

  const clearBrowsingData = async () => {
    setMenuOpen(false);
    await invoke("preview_clear_data").catch(() => {});
    // Each folder or server the preview serves has its own origin (a port on the preview host),
    // this run's and earlier ones', and each clears its own storage when asked.
    const sites = await invoke<string[]>("agent_preview_sites").catch(() => [PREVIEW_ORIGIN]);
    await Promise.all(sites.map((site) => new Promise<void>((resolve) => {
      const f = document.createElement("iframe");
      f.style.display = "none";
      f.src = `${site}/__nyxs/clear-site-data`;
      const done = () => { f.remove(); resolve(); };
      f.onload = done;
      window.setTimeout(done, 3000);
      document.body.appendChild(f);
    })));
    // Their storage is gone now; the ones not open anymore needn't be remembered.
    await invoke("agent_forget_preview_sites").catch(() => {});
    notify(t.dataCleared);
    if (hasPage) reload();
  };

  const viewportLabel: Record<Viewport, string> = {
    responsive: t.viewportResponsive,
    mobile: t.viewportMobile,
    tablet: t.viewportTablet,
    desktop: t.viewportDesktop,
  };
  const cookieLabel: Record<CookieMode, string> = {
    shared: t.cookiesShared,
    project: t.cookiesProject,
    private: t.cookiesPrivate,
  };
  const subClass = cn(
    "absolute z-40 w-56 rounded-[5px] border border-bg-300 bg-bg-100 shadow-lg p-1",
    subLeft ? "right-full top-0 mr-1" : "right-0 top-full mt-1",
  );

  return (
    <div data-mod-menu ref={menuRef} role="menu" aria-label={t.browserSettings} data-webview-hole className="absolute top-9 right-2 z-30 w-72 rounded-[5px] border border-bg-300 bg-bg-100 shadow-lg p-1">
      <MenuItem onClick={openExternal} disabled={!isHttp} onHover={() => setSub(null)}>{openInLabel}</MenuItem>
      <MenuItem onClick={copyUrl} disabled={!hasPage} onHover={() => setSub(null)}>{t.copyUrl}</MenuItem>
      <MenuItem onClick={() => void saveScreenshot()} disabled={!hasPage} onHover={() => setSub(null)}>{t.saveScreenshot}</MenuItem>
      <MenuItem onClick={() => void openHtmlFile()} onHover={() => setSub(null)}>{t.openHtmlFile}</MenuItem>
      <MenuSep />
      <div className="relative">
        <MenuItem
          onClick={() => (sub === "viewport" ? setSub(null) : openSub("viewport"))}
          onHover={() => openSub("viewport")}
          right={
            <>
              <span className="shrink-0 text-[12.5px] text-text-400">{viewportLabel[prefs.viewport]}</span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-400" />
            </>
          }
        >
          {t.viewport}
        </MenuItem>
        {sub === "viewport" && (
          <div data-mod-menu role="menu" aria-label={t.viewport} data-webview-hole className={subClass}>
            {(["responsive", "mobile", "tablet", "desktop"] as const).map((v) => (
              <MenuItem
                key={v}
                checked={prefs.viewport === v}
                onClick={() => { setBrowserPrefs({ viewport: v }); setMenuOpen(false); }}
                right={v !== "responsive" && (
                  <span className="shrink-0 text-[12px] tabular-nums text-text-400">
                    {VIEWPORT_SIZES[v].width} × {VIEWPORT_SIZES[v].height}
                  </span>
                )}
              >
                {viewportLabel[v]}
              </MenuItem>
            ))}
          </div>
        )}
      </div>
      <MenuSep />
      <MenuItem checked={prefs.openLinksInApp} onClick={() => setBrowserPrefs({ openLinksInApp: !prefs.openLinksInApp })} onHover={() => setSub(null)}>
        {t.openLinksInApp}
      </MenuItem>
      <MenuItem
        checked={verifyChanges}
        onClick={() => update({ allowPreview: !verifyChanges } as Parameters<typeof update>[0], "user")}
        onHover={() => setSub(null)}
      >
        {t.verifyChanges}
      </MenuItem>
      <MenuSep />
      <p className="px-2 pt-1 pb-0.5 text-[12px] font-medium text-text-400">{t.cookies}</p>
      <div className="relative">
        <MenuItem
          onClick={() => (sub === "cookies" ? setSub(null) : openSub("cookies"))}
          onHover={() => openSub("cookies")}
          right={
            <>
              <span className="shrink-0 text-[12.5px] text-text-400">{cookieLabel[prefs.cookies]}</span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-400" />
            </>
          }
        >
          {t.keepCookies}
        </MenuItem>
        {sub === "cookies" && (
          <div data-mod-menu role="menu" aria-label={t.keepCookies} data-webview-hole className={subClass}>
            {(["shared", "project", "private"] as const).map((c) => (
              <MenuItem key={c} checked={prefs.cookies === c} onClick={() => { setBrowserPrefs({ cookies: c }); setMenuOpen(false); }}>
                {cookieLabel[c]}
              </MenuItem>
            ))}
          </div>
        )}
      </div>
      <MenuItem onClick={() => { setMenuOpen(false); onImportCookies(); }} onHover={() => setSub(null)}>{tc.menuItem}</MenuItem>
      <MenuItem danger onClick={() => void clearBrowsingData()} onHover={() => setSub(null)}>{t.clearBrowsingData}</MenuItem>
    </div>
  );
}
