import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import { clearDiagnosticsCache } from "@/lib/diagnostics";
import {
  dismissOnboarding,
  getOnboardingSeenCount,
  isWorkspaceTrusted,
  markOnboardingSeen,
  ONBOARDING_MAX_SHOWS,
  trustWorkspace,
} from "@/lib/globalConfig";
import {
  getProjectTrustSnapshot,
  inspectProjectSettings,
  setSettingsWorkspace,
  subscribeSettings,
  trustProjectSettings,
  type ProjectTrustState,
  type TrustFinding,
} from "@/lib/settingsRuntime";
import { loadProjectMemory } from "@/lib/skills";
import { clearSystemPromptCache } from "@/lib/systemPrompt";
import { closeViewGuarded, leaveViewGuarded } from "@/lib/viewCloseGuard";
import {
  addRecentWorkspace,
  allowWorkspaceAccess,
  loadRecentWorkspaces,
  loadWorkspace,
  pickWorkspace,
  removeRecentWorkspace,
  saveWorkspace,
  workspaceExists,
  workspaceName,
} from "@/lib/workspace";

export interface PendingTrust {
  path: string;
  kind: "workspace" | "settings";
  status?: ProjectTrustState["status"];
  findings: TrustFinding[];
  resolve: (ok: boolean) => void;
}

/** The open folder and the recent ones: opening a folder (asking to trust it the first time,
 *  and again when its project settings change), dropping folders that no longer exist, and
 *  offering to create NYXS.md in a project without one. `onSwitch` runs when the folder
 *  picker opens a different folder. */
export function useWorkspace(onSwitch: () => void) {
  const [workspace, setWorkspace] = useState<string | null>(() => {
    const initial = loadWorkspace();
    void allowWorkspaceAccess(initial);
    return initial;
  });
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => loadRecentWorkspaces());
  const onSwitchRef = useRef(onSwitch);
  useLayoutEffect(() => { onSwitchRef.current = onSwitch; });

  useEffect(() => saveWorkspace(workspace), [workspace]);
  useEffect(() => {
    setSettingsWorkspace(workspace);
    clearDiagnosticsCache();
    // The folder left keeps its LSP servers while a turn still works there: useLspFoldersInUse
    // closes them once nothing uses it.
  }, [workspace]);

  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const projectTrust = useSyncExternalStore(subscribeSettings, getProjectTrustSnapshot, getProjectTrustSnapshot);
  const dismissedTrustRef = useRef<Set<string>>(new Set());
  const [pendingOpenProject, setPendingOpenProject] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [pendingOnboarding, setPendingOnboarding] = useState<{ name: string } | null>(null);

  const confirmTrust = useCallback(async (path: string): Promise<string | null> => {
    await allowWorkspaceAccess(path);
    const info = await inspectProjectSettings(path).catch(() => ({ digest: "", findings: [] as TrustFinding[] }));
    const ok = await new Promise<boolean>((resolve) =>
      setPendingTrust({ path, kind: "workspace", findings: info.findings, resolve }),
    );
    return ok ? info.digest : null;
  }, []);

  useEffect(() => {
    if (!projectTrust || projectTrust.status === "trusted" || projectTrust.workspace !== workspace) return;
    if (pendingTrust || dismissedTrustRef.current.has(projectTrust.digest)) return;
    const { workspace: path, digest, findings, status } = projectTrust;
    setPendingTrust({
      path,
      kind: "settings",
      status,
      findings,
      resolve: (ok) => {
        if (ok) void trustProjectSettings(path, digest);
        else dismissedTrustRef.current.add(digest);
      },
    });
  }, [projectTrust, workspace, pendingTrust]);

  const respondTrust = (ok: boolean) => {
    setPendingTrust((prev) => {
      prev?.resolve(ok);
      return null;
    });
  };

  /** Makes `path` the open folder, asking to trust it first if needed. False when it no
   *  longer exists or the user declined. */
  const ensureWorkspaceActive = useCallback(async (path: string): Promise<boolean> => {
    if (path === loadWorkspace()) return true;
    if (!(await workspaceExists(path))) {
      setRecentWorkspaces(removeRecentWorkspace(path));
      return false;
    }
    // Files would close on another folder: an unsaved file there asks first.
    if (!(await leaveViewGuarded("files"))) return false;
    if (!(await isWorkspaceTrusted(path))) {
      const digest = await confirmTrust(path);
      if (digest === null) return false;
      await trustWorkspace(path, digest);
    }
    await allowWorkspaceAccess(path);
    setWorkspace(path);
    setRecentWorkspaces(addRecentWorkspace(path));
    clearSystemPromptCache();
    return true;
  }, [confirmTrust]);

  const confirmOpenProject = useCallback(
    (): Promise<boolean> => new Promise((resolve) => setPendingOpenProject({ resolve })),
    [],
  );
  const respondOpenProject = (ok: boolean) => {
    setPendingOpenProject((prev) => {
      prev?.resolve(ok);
      return null;
    });
  };

  const pickAndTrustWorkspace = useCallback(async (): Promise<string | null> => {
    let picked: string | null;
    try {
      picked = await pickWorkspace();
    } catch (e) {
      console.error("No se pudo abrir el selector de carpeta", e);
      return null;
    }
    if (!picked) return null;
    if (picked !== loadWorkspace() && !(await leaveViewGuarded("files"))) return null;

    if (!(await isWorkspaceTrusted(picked))) {
      const digest = await confirmTrust(picked);
      if (digest === null) return null;
      await trustWorkspace(picked, digest);
    }
    const prev = loadWorkspace();
    await allowWorkspaceAccess(picked);
    setWorkspace(picked);
    setRecentWorkspaces(addRecentWorkspace(picked));

    if (prev !== picked) { clearSystemPromptCache(); onSwitchRef.current(); }
    return picked;
  }, [confirmTrust]);

  const forgetWorkspace = useCallback((path: string) => {
    setRecentWorkspaces(removeRecentWorkspace(path));
  }, []);

  /** Drops a folder from the recent ones; returns whether it was the open folder (now closed). */
  const closeWorkspace = useCallback((path: string): boolean => {
    if (path !== workspace) {
      setRecentWorkspaces(removeRecentWorkspace(path));
      return false;
    }
    // Closing the open folder closes Files too: an unsaved file there asks first, and the folder
    // stays open when the user keeps it.
    closeViewGuarded("files", () => {
      setRecentWorkspaces(removeRecentWorkspace(path));
      setWorkspace(null);
      saveWorkspace(null);
    });
    return true;
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    (async () => {
      if (!(await isWorkspaceTrusted(workspace))) return;
      if ((await getOnboardingSeenCount(workspace)) >= ONBOARDING_MAX_SHOWS) return;
      const memory = await loadProjectMemory(workspace);
      if (memory.trim()) return;
      if (!alive) return;
      setPendingOnboarding({ name: workspaceName(workspace) });
      await markOnboardingSeen(workspace);
    })();
    return () => { alive = false; };
  }, [workspace]);

  // Folders deleted or moved since they were opened leave the recent list, checked at start
  // and whenever the window regains focus.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ws = loadWorkspace();
      if (ws) setRecentWorkspaces((prev) => (prev.includes(ws) ? prev : addRecentWorkspace(ws)));

      const recents = loadRecentWorkspaces();
      const checks = await Promise.all(recents.map(async (p) => [p, await workspaceExists(p)] as const));
      if (!alive) return;
      const missing = checks.filter(([, ok]) => !ok).map(([p]) => p);
      if (missing.length) {
        let next = loadRecentWorkspaces();
        for (const p of missing) next = removeRecentWorkspace(p);
        setRecentWorkspaces(next);
        if (ws && missing.includes(ws)) {
          setWorkspace(null);
          saveWorkspace(null);
        }
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => { alive = false; window.removeEventListener("focus", check); };
  }, []);

  const createProjectMemory = useCallback(async () => {
    if (!workspace) return;
    const root = workspace.replace(/[\\/]+$/, "");
    const name = workspaceName(workspace);
    const starter =
      `# ${name}\n\n` +
      `## Overview\n<!-- What this project is and what it does. -->\n\n` +
      `## Conventions\n<!-- Code style, patterns and naming the agent should follow. -->\n\n` +
      `## Notes\n<!-- Anything else the agent should remember across sessions. -->\n`;
    try {
      await invoke("agent_write_file", { path: `${root}/NYXS.md`, content: starter });
      await dismissOnboarding(workspace);
    } catch (e) {
      console.error("No se pudo crear NYXS.md", e);
    }
    setPendingOnboarding(null);
  }, [workspace]);
  const dismissProjectOnboarding = useCallback(() => setPendingOnboarding(null), []);

  return {
    workspace,
    recentWorkspaces,
    ensureWorkspaceActive,
    pickAndTrustWorkspace,
    closeWorkspace,
    forgetWorkspace,
    pendingTrust,
    respondTrust,
    pendingOpenProject,
    confirmOpenProject,
    respondOpenProject,
    pendingOnboarding,
    createProjectMemory,
    dismissProjectOnboarding,
  };
}
