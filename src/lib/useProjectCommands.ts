import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { loadSkills } from "@/lib/skills";
import { loadCommands, type CommandDef } from "@/lib/commands";
import type { SlashCommand } from "@/lib/slashCommand";

/** What the open folder adds to the chat box: its skills and `/` commands (reloaded when the
 *  folder changes), and its file list for `@` mentions. */
export function useProjectCommands(workspace: string | null) {
  /** The files for `@` mentions: of `dir` (the chat's worktree) when given, else of the folder;
   *  the folder's too when the worktree can't be listed. */
  const listProjectFiles = useCallback(async (dir?: string | null): Promise<string[]> => {
    for (const root of [dir, workspace]) {
      if (!root) continue;
      try {
        return await invoke<string[]>("agent_list_files", { workspace: root });
      } catch {
        // Try the next one.
      }
    }
    return [];
  }, [workspace]);

  const [skillCommands, setSkillCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let alive = true;
    loadSkills(workspace).then((skills) => {
      if (alive) setSkillCommands(skills.map((s) => ({ name: s.name, description: s.description })));
    });
    return () => { alive = false; };
  }, [workspace]);

  const [fileCommands, setFileCommands] = useState<CommandDef[]>([]);
  // Read by the send path, which runs outside render.
  const commandsRef = useRef<CommandDef[]>([]);
  useEffect(() => { commandsRef.current = fileCommands; }, [fileCommands]);
  useEffect(() => {
    let alive = true;
    loadCommands(workspace).then((cmds) => { if (alive) setFileCommands(cmds); });
    return () => { alive = false; };
  }, [workspace]);

  return { listProjectFiles, skillCommands, fileCommands, commandsRef };
}
