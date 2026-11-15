import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { localizedError, useTranslations } from "@/lib/i18n";
import { useConfirm } from "@/lib/useConfirm";
import { invoke } from "@/lib/ipc";
import { readPreviewConfig, writePreviewConfig, type PreviewConfig } from "@/lib/previewConfig";
import { launchCwd, readLaunchConfig, scriptPinsPort, withPort, type LaunchEntry } from "@/lib/launchConfig";
import { subscribeFsChange } from "@/lib/fsWatch";
import { previewSlotOf } from "@/lib/previewControl";
import { remoteHostOf } from "@/lib/remote";
import { missingProgram, MissingProgramError } from "@/lib/remoteServerPrep";
import { shellOwner } from "@/lib/shellOwners";
import { joinPath } from "@/tools/paths";
import { killShell, useBgShells } from "../bgShells";
import { bootServer, devServerUrl, isDevServerCommand, isLocalHost, sameServer } from "./helpers";
import type { LoadTarget } from "./usePageAddress";
import type { ServerBoot } from "./ServerBootStatus";
import { useServerPrep } from "./useServerPrep";

/** A server that couldn't be started, with its last output. `missing`: a remote machine lacks a
 *  program it needs, which is what the user sees instead of that output. */
export type LaunchFailure = { name: string; message: string; missing?: { program: string; host: string } };

function failureOf(name: string, err: unknown, workspace: string | null): LaunchFailure {
  const message = localizedError(err);
  const host = remoteHostOf(workspace);
  const program = err instanceof MissingProgramError ? err.program : missingProgram(message);
  return { name, message, ...(host && program ? { missing: { program, host } } : {}) };
}

/** The tab's dev servers: the ones in .claude/launch.json and whether they answer, the one
 *  saved for the preview, starting them, and the tab following the server that runs. */
export function useDevServers({
  workspace,
  slot,
  requestedFile,
  manual,
  input,
  setInput,
  setSrc,
  setExtUrl,
  targetRef,
  loadTarget,
}: {
  workspace: string | null;
  /** The browser (one per chat) the tab belongs to. */
  slot: string;
  requestedFile?: string;
  manual: boolean;
  input: string;
  setInput: (v: string) => void;
  setSrc: (v: string | ((cur: string) => string)) => void;
  setExtUrl: (v: string | ((cur: string) => string)) => void;
  targetRef: RefObject<{ origin?: string; root?: string } | null>;
  loadTarget: LoadTarget;
}) {
  // Only this project's shells: a server running in another project must not open here.
  const { list } = useBgShells(workspace, { withOutput: false });
  // Servers listed in .claude/launch.json (the file Claude Code uses).
  const [launch, setLaunch] = useState<LaunchEntry[]>([]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<LaunchFailure | null>(null);
  const [serversOpen, setServersOpen] = useState(false);
  const serversRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!serversOpen) return;
    const h = (e: MouseEvent) => { if (serversRef.current && !serversRef.current.contains(e.target as Node)) setServersOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [serversOpen]);
  // Entries started on another port because theirs was taken (launch.json's autoPort): the
  // command and address they run with now.
  const [moved, setMoved] = useState<Record<string, { command: string; url: string }>>({});
  const runningShellOf = (e: LaunchEntry) =>
    e.command ? list.find((s) => s.status === "running" && (s.command === e.command || s.command === moved[e.name]?.command)) : undefined;
  // Entries whose address already answers, even when Nyxs didn't start them (a terminal, the
  // agent with another command): they are offered to open instead of to start.
  const [listening, setListening] = useState<string[]>([]);
  const runningIds = list.filter((s) => s.status === "running").map((s) => s.id).join(",");
  useEffect(() => {
    if (!launch.length || launching) return;
    let alive = true;
    const probe = () =>
      void Promise.all(launch.map((e) => invoke<string>("agent_wait_for_server", { url: moved[e.name]?.url ?? e.url, cwd: workspace }).then(() => e.name, () => "")))
        .then((names) => { if (alive) setListening(names.filter(Boolean)); });
    probe();
    window.addEventListener("focus", probe);
    return () => { alive = false; window.removeEventListener("focus", probe); };
  }, [launch, launching, runningIds, moved, workspace]);
  const isUp = (e: LaunchEntry) => !!runningShellOf(e) || listening.includes(e.name);
  // A server that answers can be stopped even when Nyxs didn't start it: whatever listens on
  // its port is closed, after saying which process that is.
  const tr = useTranslations();
  const [confirm, confirmElement] = useConfirm();
  const [stopping, setStopping] = useState<string | null>(null);
  // A development build of Nyxs is served by the project's own dev server: stopping that port
  // would take the app's window down with it.
  const ownPort = isLocalHost(window.location.hostname) ? Number(window.location.port) || 0 : 0;
  const canStop = (e: LaunchEntry) =>
    e.port !== ownPort && (!!runningShellOf(e) || (!!e.port && listening.includes(e.name)));
  const forgetPort = (port: number) =>
    setListening((names) => names.filter((n) => !launch.some((x) => x.name === n && x.port === port)));
  const stopServer = async (e: LaunchEntry) => {
    const shell = runningShellOf(e);
    if (shell) {
      killShell(shell.id);
      return;
    }
    const port = e.port;
    if (!port || stopping) return;
    const owners = await invoke<{ pid: number; name: string }[]>("agent_port_listeners", { port }).catch(() => []);
    if (!owners.length) {
      // Nobody found on the port: let the backend check it really is free instead of marking
      // it stopped here, which only hid it in this tab while it kept running.
      setLaunchError(null);
      try {
        await invoke("agent_stop_port", { port });
        forgetPort(port);
      } catch (err) {
        setLaunchError({ name: e.name, message: localizedError(err) });
      }
      return;
    }
    const ok = await confirm({
      title: tr.views.stopExternalTitle.replace("{port}", String(port)),
      message: tr.views.stopExternalBody.replace("{process}", owners.map((o) => `${o.name} (PID ${o.pid})`).join(", ")),
      confirmLabel: tr.views.stopServerNamed.replace("{name}", e.name),
      cancelLabel: tr.modals.cancel,
      danger: true,
    });
    if (!ok) return;
    setStopping(e.name);
    setLaunchError(null);
    try {
      await invoke("agent_stop_port", { port });
      forgetPort(port);
    } catch (err) {
      setLaunchError({ name: e.name, message: localizedError(err) });
    } finally {
      setStopping(null);
    }
  };
  const isServer = (cmd: string) =>
    isDevServerCommand(cmd) || launch.some((e) => e.command === cmd) || Object.values(moved).some((m) => m.command === cmd);
  // A launch entry knows its real port; otherwise the port is guessed from the command.
  const serverUrl = (cmd: string) =>
    Object.values(moved).find((m) => m.command === cmd)?.url ?? launch.find((e) => e.command === cmd)?.url ?? devServerUrl(cmd);
  // The tab opens by itself, and closes, only what isn't another chat's: the agent of another
  // session starting or restarting a server must not move a page the user has open here. The
  // list above still knows those servers, to offer them and not start them twice.
  const ownShells = list.filter((s) => {
    const owner = shellOwner(s.id);
    return !owner || previewSlotOf(owner) === slot;
  });
  const runningServer = ownShells.find((s) => s.status === "running" && isServer(s.command));
  const serverCmd = runningServer?.command;
  const serverCmdUrl = serverCmd ? serverUrl(serverCmd) : "";

  const [hasDevScript, setHasDevScript] = useState(false);
  const [config, setConfig] = useState<PreviewConfig | null>(null);
  const [starting, setStarting] = useState(false);
  // The server being started, shown with its output while it boots.
  const [boot, setBoot] = useState<ServerBoot | null>(null);
  const cancelled = useRef(false);
  const watchBoot = useCallback((name: string) => {
    cancelled.current = false;
    return (shellId: string, started: boolean) => setBoot({ name, shellId, started });
  }, []);
  /** Stops the server the tab started: its wait ends with the shell, and no error is shown. */
  const cancelBoot = useCallback(() => {
    if (!boot?.started) return;
    cancelled.current = true;
    killShell(boot.shellId);
  }, [boot]);
  const { prep, prepare, answerPrep, clearPrep } = useServerPrep(workspace);
  /** Whether something already answers at `url`: nothing to prepare or start then. */
  const answers = (url: string) => invoke<string>("agent_wait_for_server", { url, cwd: workspace }).then(() => true, () => false);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    invoke<string | null>("agent_read_text", { path: joinPath(workspace, "package.json") })
      .then((raw) => {
        if (!alive) return;
        try {
          const pkg = JSON.parse(raw ?? "");
          setHasDevScript(Boolean(pkg.scripts && (pkg.scripts.dev || pkg.scripts.start || pkg.scripts.serve)));
        } catch { setHasDevScript(false); }
      })
      .catch(() => { if (alive) setHasDevScript(false); });
    return () => { alive = false; };
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void readPreviewConfig(workspace).then((c) => { if (alive) setConfig(c); });
    return () => { alive = false; };
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const read = () => void readLaunchConfig(workspace).then((entries) => { if (alive) setLaunch(entries); });
    read();
    const unsub = subscribeFsChange(workspace, read);
    window.addEventListener("focus", read);
    return () => { alive = false; unsub(); window.removeEventListener("focus", read); };
  }, [workspace]);

  useEffect(() => {
    if (!workspace || !serverCmd) return;
    const next: PreviewConfig = { command: serverCmd, url: serverCmdUrl };
    if (config && config.command === next.command && config.url === next.url) return;
    void writePreviewConfig(workspace, next).then(() => setConfig(next));
  }, [workspace, serverCmd, serverCmdUrl, config]);

  /** Starts a launch.json server (or just opens it, for an entry that only attaches) and
   *  shows it once it listens. A server that already answers is simply opened. */
  const startLaunch = useCallback(
    async (entry: LaunchEntry): Promise<boolean> => {
      if (!workspace || launching) return false;
      setLaunchError(null);
      if (!entry.command) { await loadTarget(entry.url, true); return true; }
      setLaunching(entry.name);
      let ok = false;
      try {
        const own = list.find((s) => s.status === "running" && (s.command === entry.command || s.command === moved[entry.name]?.command));
        let run = { command: entry.command, url: own ? moved[entry.name]?.url ?? entry.url : entry.url, env: entry.env };
        if (!own && entry.port) {
          const taken = await invoke<string>("agent_wait_for_server", { url: entry.url, cwd: workspace }).then(() => true, () => false);
          // Another server of this launch.json, started by Nyxs, holds the port.
          const rival = taken
            ? launch.find((x) => x.name !== entry.name && x.port === entry.port && list.some((s) => s.status === "running" && s.command === x.command))
            : undefined;
          if (taken && (entry.autoPort === true || (entry.autoPort === null && rival))) {
            if (entry.autoPort === null) {
              const pkg = await invoke<string | null>("agent_read_text", { path: `${launchCwd(workspace, entry).replace(/[\\/]+$/, "")}/package.json` }).catch(() => null);
              if (scriptPinsPort(entry, pkg)) throw new Error(tr.views.portPinned.replace(/\{port\}/g, String(entry.port)));
            }
            const port = await invoke<number>("agent_free_port", { after: entry.port });
            run = withPort(entry, port);
            setMoved((m) => ({ ...m, [entry.name]: { command: run.command, url: run.url } }));
          } else if (taken && rival && entry.autoPort === false) {
            throw new Error(tr.views.portInUse.replace("{port}", String(entry.port)).replace("{other}", rival.name));
          }
          // Otherwise what answers is opened, as for a server started outside Nyxs.
        }
        const cwd = launchCwd(workspace, entry);
        const onShell = watchBoot(entry.name);
        const go = own || (await answers(run.url)) || (await prepare(entry.name, cwd, run.command, onShell));
        if (go) {
          const url = await bootServer({
            command: run.command,
            cwd,
            description: entry.name,
            url: run.url,
            env: run.env,
            shellId: own?.id,
            onShell,
          });
          await loadTarget(url, true);
          ok = true;
        }
      } catch (e) {
        if (!cancelled.current) setLaunchError(failureOf(entry.name, e, workspace));
      }
      clearPrep();
      setBoot(null);
      setLaunching(null);
      return ok;
    },
    [workspace, launching, list, loadTarget, launch, moved, tr, watchBoot, prepare, clearPrep],
  );

  const startSavedServer = useCallback(async () => {
    if (!config || !workspace || starting) return;
    setStarting(true);
    setLaunchError(null);
    try {
      const shellId = list.find((s) => s.status === "running" && s.command === config.command)?.id;
      const onShell = watchBoot(config.command);
      const go = shellId || (await answers(config.url)) || (await prepare(config.command, workspace, config.command, onShell));
      if (go) {
        const url = await bootServer({
          command: config.command,
          cwd: workspace,
          description: tr.previewTexts.devServerName,
          url: config.url,
          shellId,
          onShell,
        });
        await loadTarget(url, false);
      }
    } catch (e) {
      if (!cancelled.current) setLaunchError(failureOf(config.command, e, workspace));
    }
    clearPrep();
    setBoot(null);
    setStarting(false);
  }, [config, workspace, starting, list, loadTarget, watchBoot, prepare, clearPrep, tr]);

  useEffect(() => {
    if (!requestedFile) return;
    const rf = requestedFile.trim();
    if (/^https?:\/\//i.test(rf) || /\.html?($|[?#])/i.test(rf)) {
      void Promise.resolve().then(() => loadTarget(rf, false));
    } else if (serverCmd) {
      void Promise.resolve().then(() => loadTarget(serverCmdUrl, false));
    }
  }, [requestedFile, serverCmd, serverCmdUrl, loadTarget]);

  useEffect(() => {
    // While a server boots its shell already counts as running; opening it before it listens
    // would leave the browser on a "can't connect" page.
    if (manual || requestedFile || launching || starting) return;
    void Promise.resolve().then(() => {
      if (serverCmd) return loadTarget(serverCmdUrl, false);
      setSrc((cur) => (/localhost/i.test(cur) ? "" : cur));
      setExtUrl((cur) => {
        try { return isLocalHost(new URL(cur).hostname) ? "" : cur; } catch { return cur; }
      });
    });
  }, [serverCmd, serverCmdUrl, manual, requestedFile, launching, starting, loadTarget, setSrc, setExtUrl]);

  // A page whose server stops is closed, so the tab goes back to the list of servers.
  const runningUrls = ownShells.filter((s) => s.status === "running" && isServer(s.command)).map((s) => serverUrl(s.command)).join("\n");
  const prevRunningUrls = useRef(runningUrls);
  useEffect(() => {
    const before = prevRunningUrls.current.split("\n").filter(Boolean);
    prevRunningUrls.current = runningUrls;
    const now = runningUrls.split("\n").filter(Boolean);
    const stopped = before.filter((u) => !now.some((n) => sameServer(n, u)));
    if (!stopped.length || !input || !stopped.some((u) => sameServer(u, input))) return;
    targetRef.current = null;
    setSrc("");
    setExtUrl("");
    setInput("");
  }, [runningUrls, input, targetRef, setSrc, setExtUrl, setInput]);

  return {
    launch,
    launching,
    launchError,
    serversOpen,
    setServersOpen,
    serversRef,
    runningShellOf,
    isUp,
    canStop,
    stopServer,
    stopping,
    stopConfirm: confirmElement,
    startLaunch,
    startSavedServer,
    hasDevScript,
    config,
    starting,
    boot,
    cancelBoot,
    prep,
    answerPrep,
  };
}
