import { useEffect, useState, type ReactNode } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Check, ChevronRight, Copy, FolderOpen, Loader2 } from "lucide-react";
import { NyxsMascot } from "@/components/NyxsMascot";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/ipc";
import { useTranslations } from "@/lib/i18n";
import { userNyxsDir } from "@/lib/paths";
import { useUpdater } from "@/lib/updater";

/** What `device_info` reports about this computer (snake_case, as the backend sends it). */
interface DeviceDetails {
  os?: string;
  os_version?: string;
  arch?: string;
  cpu?: string;
  total_memory?: string;
}

/** Settings › About: the installed version and its updates, the core that runs the agents, where
 *  the data lives, and the details to attach to a bug report. */
export function AboutPage({ onWhatsNew }: { onWhatsNew?: () => void }) {
  const t = useTranslations();
  const a = t.settings.aboutPage;
  const tu = t.update;
  const u = useUpdater();
  const [version, setVersion] = useState<string | null>(null);
  const [tauriVersion, setTauriVersion] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceDetails | null>(null);
  const [core, setCore] = useState<"checking" | "ok" | "down">("checking");
  const [dataDir, setDataDir] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Background polls also run while this is on screen: only a check the user asked for answers
  // here, so "you have the latest version" doesn't appear on its own.
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let alive = true;
    void getVersion().then((v) => { if (alive) setVersion(v); }, () => {});
    void getTauriVersion().then((v) => { if (alive) setTauriVersion(v); }, () => {});
    void userNyxsDir().then((d) => { if (alive) setDataDir(d); }, () => {});
    // The backend answers this only while the core runs, so its answer is also the core's status.
    void invoke<DeviceDetails>("device_info").then(
      (d) => { if (alive) { setDevice(d ?? {}); setCore("ok"); } },
      () => { if (alive) setCore("down"); },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  // Outside the desktop app there is no installed version to show.
  if (!version) return null;

  const searching = asked && u.checking;
  const check = () => {
    setAsked(true);
    void u.recheck();
  };

  let status: string | null = null;
  if (u.status === "error") status = tu.updateFailed;
  else if (u.status === "ready") status = tu.restarting;
  else if (u.status === "downloading") status = tu.downloading.replace("{pct}", String(Math.round(u.progress * 100)));
  else if (u.status === "available") status = tu.newVersionAvailable.replace("{version}", u.version ? ` (${u.version})` : "");
  else if (asked && !u.checking) status = u.checkFailed ? a.checkFailed : a.upToDate;

  const webView = /Edg\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null;
  const system = device?.os ? [device.os, device.os_version, device.arch].filter(Boolean).join(" ") : null;
  const startedAt = new Date(performance.timeOrigin).toLocaleString();
  const rows = ([
    ["Tauri", tauriVersion],
    ["WebView2", webView],
    [a.techSystem, system],
    [a.techCpu, device?.cpu ?? null],
    [a.techMemory, device?.total_memory ?? null],
    [a.techStarted, startedAt],
  ] as [string, string | null][]).filter((r): r is [string, string] => Boolean(r[1]));

  const copyDetails = () => {
    const text = [`Nyxs ${version}`, ...rows.map(([k, v]) => `${k}: ${v}`)].join("\n");
    void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
  };

  const coreStatus = core === "ok"
    ? { label: a.coreConnected, cls: "bg-green-500/10 text-green-500" }
    : core === "down"
      ? { label: a.coreDisconnected, cls: "bg-red-500/10 text-red-500" }
      : { label: a.coreChecking, cls: "bg-bg-300 text-text-400" };

  return (
    <div className="space-y-8">
      <h2 className="text-[18px] font-medium text-text-100">{t.settings.about}</h2>

      <div className="rounded-[8px] bg-bg-200 px-4 py-4">
        <div className="flex items-center gap-3">
          <NyxsMascot mood="rest" size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-100">Nyxs</p>
            <p className="text-[12px] text-text-400 mt-0.5">{a.tagline}</p>
          </div>
          <p className="text-[12px] font-mono text-text-400 shrink-0">{a.version.replace("{version}", version)}</p>
        </div>

        <Row title={a.updates} desc={status ? <span aria-live="polite">{status}</span> : null}>
          {onWhatsNew && (
            <Button onClick={onWhatsNew}>{t.changelog.whatsNew}</Button>
          )}
          {u.status === "available" ? (
            <Button variant="primary" onClick={() => void u.install()}>{tu.installAndRestart}</Button>
          ) : u.status === "error" ? (
            <Button onClick={check}>{tu.retry}</Button>
          ) : u.status === "idle" ? (
            <Button onClick={check} disabled={searching}>
              {searching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {searching ? a.checking : a.checkUpdates}
            </Button>
          ) : null}
        </Row>

        <Row title={a.credits} desc={a.creditsDesc} />

        <Row title={a.core} desc={a.coreDesc}>
          <span className={`rounded-[6px] px-2 py-0.5 text-[12px] ${coreStatus.cls}`}>{coreStatus.label}</span>
        </Row>

        <Row title={a.data} desc={a.dataDesc}>
          <Button disabled={!dataDir} onClick={() => void invoke("agent_open_path", { path: dataDir }).catch(() => undefined)}>
            <FolderOpen className="w-3.5 h-3.5" />
            {a.openData}
          </Button>
        </Row>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm text-text-300 hover:text-text-100 transition-colors"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          {a.technical}
        </button>

        {open && (
          <>
            <dl className="mt-3 rounded-[8px] bg-bg-200 px-4">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-t border-bg-300 first:border-t-0 py-2.5 text-[13px]">
                  <dt className="text-text-400 shrink-0">{label}</dt>
                  <dd className="min-w-0 truncate text-right text-text-100">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-2 flex items-center gap-3">
              <Button onClick={copyDetails}>
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? a.copied : a.copyDetails}
              </Button>
              <span className="text-[12px] text-text-400">{a.copyHint}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-bg-300 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-100">{title}</p>
        {desc && <p className="text-[12px] text-text-400 mt-0.5">{desc}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
