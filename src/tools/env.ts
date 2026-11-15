import { cachedRemoteInfo, remoteHostOf, remoteOsName } from "@/lib/remote";

export interface ToolPromptEnv {
  shell: string;
  git: boolean;
  backgroundTasks: boolean;
  sandbox: boolean;
  embeddedSearchTools: boolean;
  defaultBashTimeoutMs: number;
  maxBashTimeoutMs: number;
}

export interface HostPlatform {
  os: "Windows" | "macOS" | "Linux";
  shell: string;
  /** The machine's name when the project is on another computer (`ssh://`). */
  remoteHost?: string;
}

/** Where the tools run: this PC, or for an `ssh://` workspace the machine it is on (its OS
 *  and login shell, known once it has connected). */
export function hostPlatform(workspace?: string | null): HostPlatform {
  const host = remoteHostOf(workspace);
  if (host) {
    const info = cachedRemoteInfo(host);
    const os = remoteOsName(info?.os);
    return { os, shell: os === "Windows" ? "PowerShell" : info?.shell || "bash", remoteHost: host };
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return { os: "Windows", shell: "PowerShell" };
  if (/Macintosh|Mac OS X/i.test(ua)) return { os: "macOS", shell: "bash" };
  return { os: "Linux", shell: "bash" };
}

let detectedShell: string | null = null;

export async function loadShellInfo(): Promise<void> {
  if (detectedShell !== null) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    detectedShell = await invoke<string>("agent_shell_info");
  } catch {
    detectedShell = "";
  }
}

export function defaultToolPromptEnv(workspace?: string | null): ToolPromptEnv {
  const remote = hostPlatform(workspace);
  return {
    shell: remote.remoteHost ? remote.shell : detectedShell === "pwsh" ? "PowerShell 7" : remote.shell,
    git: true,
    backgroundTasks: true,
    sandbox: false,
    embeddedSearchTools: false,
    defaultBashTimeoutMs: 120_000,
    maxBashTimeoutMs: 600_000,
  };
}
