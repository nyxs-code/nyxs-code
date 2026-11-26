import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Chat } from "@/lib/chatStore";
import { claudeCodeSessionOf } from "@/lib/claudeCodeUsage";
import { installBundledPlugins } from "@/lib/plugins/bundled";
import { modHost, setReservedCommands, setSessionInfoSource } from "./io";
import { paintModTheme } from "./paint";

/** Fired when installed plugins change (enabled, disabled, installed, updated). */
export const PLUGINS_CHANGED_EVENT = "nyxs:plugins-changed";

/** The key a new session's mods run under until its first message gives it an id. */
export const draftModKey = (workspace: string | null) => `draft:${workspace ?? ""}`;

export const modKeyOf = (chatId: string | null, workspace: string | null) => chatId ?? draftModKey(workspace);

/** The command a message runs when it is `/name args` of a mod's command in that session. */
export function matchModCommand(text: string, key: string): { name: string; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !modHost.hasCommand(key, m[1])) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/**
 * Runs the open session's mods: loads them when the session opens, paints its theme, keeps the
 * app's command names out of their reach, and lists their `/` commands for the chat box.
 */
export function useMods(o: {
  activeId: string | null;
  workspace: string | null;
  chats: Chat[];
  reservedCommands: string[];
  /** The session is on screen. A theme dresses only its session, as in Claude's desktop app: the
   *  app's own pages (Scheduled, Plugins…) keep the app's look. */
  themed: boolean;
}) {
  const { activeId, workspace, chats, reservedCommands, themed } = o;
  const live = useRef({ chats, workspace });
  useEffect(() => {
    live.current = { chats, workspace };
  });

  useEffect(() => {
    setSessionInfoSource((key) => {
      const { chats: all, workspace: ws } = live.current;
      const chat = all.find((c) => c.id === key);
      if (!chat) return { chatId: null, workspace: key.startsWith("draft:") ? key.slice(6) || ws : ws, cwd: ws, model: null, turns: 0 };
      const root = chat.workspace ?? ws;
      return {
        chatId: chat.id,
        workspace: root,
        cwd: chat.worktree?.path ?? root,
        model: chat.model ?? null,
        turns: chat.messages.filter((m) => m.role === "user").length,
        cliSessionId: claudeCodeSessionOf(chat.messages.map((m) => m.responseMessages)) ?? null,
      };
    });
  }, []);

  const reservedKey = reservedCommands.join("\n");
  useEffect(() => {
    const names = new Set(reservedKey.split("\n").map((n) => n.toLowerCase()));
    setReservedCommands((name) => names.has(name.toLowerCase()));
  }, [reservedKey]);

  const key = modKeyOf(activeId, workspace);
  useEffect(() => {
    // The plugins Nyxs ships go in first, so the session loads them with the rest.
    void installBundledPlugins().then(() => modHost.activate(key));
  }, [key]);

  useEffect(() => {
    const reload = () => void modHost.reloadInstalled();
    window.addEventListener(PLUGINS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, reload);
  }, []);

  const version = useSyncExternalStore(modHost.subscribe, modHost.getVersion);
  const theme = modHost.theme(key);
  // A session whose mods haven't loaded yet has no known look: painting "none" meanwhile flashed
  // the app's own colors for a moment on every first switch to it.
  const known = theme !== null || modHost.isSettled(key);
  useEffect(() => {
    if (!themed) paintModTheme(null);
    else if (known) paintModTheme(theme);
  }, [theme, known, themed]);

  const commands = useMemo(
    () => modHost.commands(key).map((c) => ({ name: c.name, description: c.description })),
    // `version` changes whenever a mod registers or drops a command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, version],
  );
  return { modKey: key, modCommands: commands };
}
