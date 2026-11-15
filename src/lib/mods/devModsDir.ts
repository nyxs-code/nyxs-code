import { userNyxsDir } from "@/lib/paths";
import { joinPath } from "@/lib/plugins/catalog";

/** Where the agent writes the mods of one session: `~/.nyxs/dev-mods/<session id>/<mod>/`. */
export async function devModsDir(sessionId: string): Promise<string | null> {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return null;
  return joinPath(joinPath(await userNyxsDir(), "dev-mods"), sessionId);
}
