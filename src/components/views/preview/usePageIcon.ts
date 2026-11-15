import { useEffect, useState, type RefObject } from "react";
import { invoke } from "@/lib/ipc";

/** Reports the page's icon for its tab through `onIcon`. */
export function usePageIcon({
  tabId,
  src,
  extUrl,
  active,
  iframeRef,
  onIcon,
}: {
  tabId: string;
  src: string;
  extUrl: string;
  active: boolean;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onIcon: (tabId: string, icon: string) => void;
}) {
  // The page's own icon for its tab: local pages post it once loaded, websites are asked.
  const [icon, setIcon] = useState("");
  const iconKey = `${src}|${extUrl}`;
  const [lastIconKey, setLastIconKey] = useState(iconKey);
  if (iconKey !== lastIconKey) {
    setLastIconKey(iconKey);
    setIcon("");
  }
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { source?: string; icon?: string } | null;
      if (d?.source === "nyxs-agent-icon") setIcon(String(d.icon ?? ""));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [iframeRef]);
  useEffect(() => {
    if (!extUrl) return;
    let alive = true;
    let tries = 0;
    let timer: number | undefined;
    const check = async () => {
      const s = await invoke<{ icon: string | null } | null>("preview_agent_status", { tab: tabId }).catch(() => null);
      if (!alive) return;
      if (s) setIcon(s.icon ?? "");
      // A page still loading is asked often, so its icon shows as soon as its <head> names it.
      // The tab in front then follows where its page goes; one behind stops once it has it.
      const waiting = s?.icon == null;
      if (active || (waiting && ++tries < 60)) timer = window.setTimeout(check, waiting ? 250 : 1500);
    };
    void check();
    return () => { alive = false; clearTimeout(timer); };
  }, [extUrl, active, tabId]);
  useEffect(() => { onIcon(tabId, icon); }, [tabId, icon, onIcon]);
}
