import { useEffect, useMemo, useRef, type RefObject } from "react";
import { invoke } from "@/lib/ipc";
import { reloadPreviewWebview, PREVIEW_ORIGIN, previewMessageTarget, previewSite, type Bounds } from "@/lib/previewWebview";
import { registerPreviewTab, setPreviewFront, type PreviewController, type PreviewPageInfo } from "@/lib/previewControl";
import type { LoadTarget } from "./usePageAddress";

/** The preview's address with any site's port, wherever it shows in a page's text. */
const PREVIEW_SITE_IN_TEXT = new RegExp(`${PREVIEW_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(:\\d+)?`, "g");

/** The agent of the browser's chat drives the tab's page (previewControl), on screen (`active`)
 *  or not: the tab in `front` unless it opened or chose another. */
export function usePreviewController({
  slot,
  tabId,
  front,
  active,
  src,
  extUrl,
  input,
  loadTarget,
  setManual,
  setReloadKey,
  targetRef,
  iframeRef,
  contentBounds,
}: {
  /** The browser this tab belongs to (one per chat). */
  slot: string;
  tabId: string;
  front: boolean;
  active: boolean;
  src: string;
  extUrl: string;
  input: string;
  loadTarget: LoadTarget;
  setManual: (manual: boolean) => void;
  setReloadKey: (update: (k: number) => number) => void;
  targetRef: RefObject<{ origin?: string; root?: string } | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  contentBounds: () => Bounds | null;
}) {
  // ---- The agent's browser tools reach this tab through its chat's browser ----
  const pageRef = useRef({ src, extUrl, input });
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { pageRef.current = { src, extUrl, input }; });
  const loadTargetRef = useRef(loadTarget);
  useEffect(() => { loadTargetRef.current = loadTarget; }, [loadTarget]);
  const replies = useRef(new Map<string, (reply: { ok: boolean; result?: unknown; error?: string }) => void>());
  /** Resolved with the page's address when the bridge in a freshly loaded page says hello. */
  const readyWaiters = useRef(new Set<(url: string) => void>());
  /** Set while this tab is loading a page the agent asked for; commands wait for it. */
  const loading = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { source?: string; id?: string; url?: string; ok?: boolean; result?: unknown; error?: string } | null;
      if (d?.source === "nyxs-agent-ready") {
        for (const wake of [...readyWaiters.current]) wake(String(d.url ?? ""));
      } else if (d?.source === "nyxs-agent-reply" && d.id) {
        replies.current.get(d.id)?.({ ok: !!d.ok, result: d.result, error: d.error });
        replies.current.delete(d.id);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [iframeRef]);

  const controller = useMemo<PreviewController>(() => {
    /** The page's real address: the preview serves local servers under its own origin. */
    const realUrl = (url: string) => {
      const origin = targetRef.current?.origin;
      const site = previewSite(url);
      return origin && site ? origin + url.slice(site.length) : url;
    };
    const nextReady = (timeoutMs: number) =>
      new Promise<string | null>((resolve) => {
        const wake = (url: string) => { clearTimeout(timer); readyWaiters.current.delete(wake); resolve(url); };
        const timer = setTimeout(() => { readyWaiters.current.delete(wake); resolve(null); }, timeoutMs);
        readyWaiters.current.add(wake);
      });
    const info = (): PreviewPageInfo => {
      const p = pageRef.current;
      if (p.extUrl) return { kind: "external", url: p.extUrl };
      if (p.src.startsWith(PREVIEW_ORIGIN)) return { kind: "local", url: p.input };
      if (p.src) return { kind: "file", url: p.input };
      return { kind: "empty", url: "" };
    };
    const loaded = (url: string | null, asked: string) =>
      url ? `Loaded ${realUrl(url)}.` : `Opened ${asked}, but the page didn't finish loading within 20 s. Take a snapshot to see what it shows.`;
    // Websites live in the tab's native webview; the bridge there is reached through Rust.
    type SiteStatus = { doc: string | null; url: string; state: string; title: string };
    const siteStatus = () => invoke<SiteStatus | null>("preview_agent_status", { tab: tabId }).catch(() => null);
    /** Waits for the tab's website to show a new document that has finished loading. */
    const siteLoaded = async (before: string | null, timeoutMs: number): Promise<SiteStatus | null> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const s = await siteStatus();
        // A new tab sits on about:blank for a moment while its color scheme is set.
        if (s && s.state === "complete" && s.url !== "about:blank") {
          if (s.doc && s.doc !== before) return s;
          // A webview made before the bridge existed has no document id: trust the load state.
          if (!s.doc && Date.now() - startedAt > 1500) return s;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    };
    const siteLoadedText = (s: SiteStatus | null, asked: string) =>
      s
        ? `Loaded ${s.url}${s.title ? ` ("${s.title}")` : ""}. Use snapshot to read it and click/fill/press_key to use it.`
        : `Opened ${asked}, but the page didn't finish loading within 20 s. Take a snapshot to see what it shows.`;
    const sameAddress = (a: string, b: string) => {
      const norm = (v: string) => {
        try { return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).href; } catch { return v; }
      };
      return norm(a) === norm(b);
    };

    const run = async (start: () => Promise<PreviewPageInfo["kind"]>, asked: string, reloading = false) => {
      const ready = nextReady(20_000);
      const work = (async () => {
        const before = (await siteStatus())?.doc ?? null;
        const shownBefore = pageRef.current.extUrl;
        const kind = await start();
        if (kind === "local") return loaded(await ready, asked);
        if (kind === "external") {
          // The same address again doesn't navigate the webview: load it afresh instead.
          if (!reloading && shownBefore && sameAddress(shownBefore, asked)) await reloadPreviewWebview(tabId);
          return siteLoadedText(await siteLoaded(before, 20_000), asked);
        }
        if (kind === "file") return `Opened ${asked}. It isn't served as a web page, so it can't be read or driven.`;
        return "The browser shows an empty tab.";
      })();
      // Each step has its own wait, but opening the tab's webview doesn't: a navigate that never
      // settles would keep the tool row spinning and block every later browser command behind it.
      const job = Promise.race([
        work,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(`Opened ${asked}, but the browser didn't respond within 45 s. Take a snapshot to see what it shows.`), 45_000),
        ),
      ]);
      loading.current = job;
      try { return await job; } finally { if (loading.current === job) loading.current = null; }
    };
    return {
      info,
      navigate: (url) =>
        run(async () => {
          // The tab keeps this page instead of jumping to a dev server that starts later.
          setManual(true);
          const kind = await loadTargetRef.current(url, false);
          // Load it afresh even if the address is the one already showing.
          if (kind === "local") setReloadKey((k) => k + 1);
          return kind;
        }, url),
      reload: async () => {
        const now = info();
        if (now.kind === "external") {
          return run(async () => {
            await reloadPreviewWebview(tabId);
            return "external";
          }, now.url, true).then((text) => text.replace(/^Loaded /, "Reloaded "));
        }
        if (now.kind !== "local") throw new Error("There is no local page to reload. Use navigate first.");
        return run(async () => { setReloadKey((k) => k + 1); return "local"; }, now.url);
      },
      exec: async (cmd, args = {}, timeoutMs = 15_000) => {
        if (loading.current) await loading.current;
        const now = info();
        if (now.kind === "external") {
          return invoke<string>("preview_agent_run", { tab: tabId, cmd, args, timeoutMs });
        }
        if (now.kind !== "local") {
          throw new Error(
            now.kind === "empty"
              ? "The browser has no page open. Use navigate first."
              : `The page showing (${now.url}) is a file the browser can't serve as a web page, so it can't be read or driven.`,
          );
        }
        const win = iframeRef.current?.contentWindow;
        if (!win) throw new Error("The page isn't loaded yet.");
        const id = `${tabId}-${Math.random().toString(36).slice(2, 10)}`;
        const navigated = nextReady(timeoutMs);
        const reply = new Promise<{ ok: boolean; result?: unknown; error?: string } | null>((resolve) => {
          replies.current.set(id, resolve);
          setTimeout(() => resolve(null), timeoutMs);
        });
        win.postMessage({ source: "nyxs-agent", id, cmd, args }, previewMessageTarget(iframeRef.current?.src ?? ""));
        const first = await Promise.race([reply, navigated.then((url) => (url ? { navigated: url } : null))]);
        replies.current.delete(id);
        if (first && "navigated" in first) return `Done. The page navigated to ${realUrl(first.navigated)}.`;
        if (!first) throw new Error(`The page didn't answer within ${Math.round(timeoutMs / 1000)} s. It may be busy, or not an HTML page.`);
        if (!first.ok) throw new Error(first.error || "The command failed.");
        const origin = targetRef.current?.origin;
        if (typeof first.result !== "string") return String(first.result);
        return origin ? first.result.replace(PREVIEW_SITE_IN_TEXT, origin) : first.result;
      },
      bounds: () => contentBounds(),
      // A website is drawn by the tab's own webview; a local page is part of the app's.
      capture: (b) => invoke<string>("preview_capture_png", { ...b, tab: info().kind === "external" ? tabId : null }),
      onScreen: () => activeRef.current,
    };
  }, [tabId, contentBounds, setManual, setReloadKey, targetRef, iframeRef]);

  useEffect(() => registerPreviewTab(slot, tabId, controller), [slot, tabId, controller]);
  useEffect(() => {
    if (front) setPreviewFront(slot, tabId, active);
  }, [slot, tabId, front, active, controller]);
}
