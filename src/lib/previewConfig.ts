import { invoke } from "@/lib/ipc";

export interface PreviewConfig {
  command: string;
  url: string;
}

// The server command a project ran and its address: state Nyxs writes, so it's kept with the
// project's other state in Nyxs' data folder, not in the project (the backend moves one an
// earlier version left in `.nyxs/preview.json`).

export async function readPreviewConfig(workspace: string): Promise<PreviewConfig | null> {
  try {
    const raw = await invoke<string | null>("agent_preview_config_read", { workspace });
    if (!raw) return null;
    const cfg = JSON.parse(raw) as Partial<PreviewConfig>;
    if (cfg && typeof cfg.command === "string" && typeof cfg.url === "string") {
      return { command: cfg.command, url: cfg.url };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writePreviewConfig(workspace: string, config: PreviewConfig): Promise<void> {
  try {
    await invoke("agent_preview_config_write", {
      workspace,
      content: JSON.stringify(config, null, 2) + "\n",
    });
  } catch {
    /* best-effort: a missing config just falls back to asking the agent */
  }
}
