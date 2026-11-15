import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Chat } from "@/lib/chatStore";
import { setChatModeResolver } from "@/lib/chatModes";
import type { PermissionMode } from "@/components/ui/chat-input/types";
import { loadSelectedModel, saveSelectedModel } from "@/lib/settings";
import { loadWorkspace, loadPermissionMode, savePermissionMode } from "@/lib/workspace";
import { getMergedSettings, getMergedSnapshot, subscribeSettings } from "@/lib/settingsRuntime";

interface ChatModeOptions {
  activeId: string | null;
  liveChatsRef: RefObject<Chat[]>;
  liveActiveIdRef: RefObject<string | null>;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  /** Settings allow "skip permissions". */
  allowPermissionBypass: boolean;
  /** Takes the user to the setting that allows "skip permissions". */
  promptEnableBypass: () => void;
}

const bypassAllowed = () => (getMergedSnapshot() as { allowPermissionBypass?: boolean }).allowPermissionBypass ?? false;

/** The model and permission mode in the picker. They follow the open chat (each chat keeps its
 *  own), and "skip permissions" falls back to "accept edits" whenever settings stop allowing it. */
export function useChatModeAndModel({
  activeId,
  liveChatsRef,
  liveActiveIdRef,
  setChats,
  allowPermissionBypass,
  promptEnableBypass,
}: ChatModeOptions) {
  const [selectedModel, setSelectedModel] = useState(() => loadSelectedModel());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => loadPermissionMode(loadWorkspace()));
  // Read by turns while they run, which outlive the render that started them.
  const modeRef = useRef(permissionMode);
  useEffect(() => { modeRef.current = permissionMode; }, [permissionMode]);

  /** The permission mode a chat runs in: the open chat follows the picker, others keep theirs. */
  const chatModeOf = useCallback(
    (chatId: string | undefined): PermissionMode =>
      !chatId || chatId === liveActiveIdRef.current
        ? modeRef.current
        : liveChatsRef.current.find((c) => c.id === chatId)?.permissionMode ?? modeRef.current,
    [liveActiveIdRef, liveChatsRef],
  );

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    if (mode === "skip" && !allowPermissionBypass) {
      promptEnableBypass();
      return;
    }
    setPermissionMode(mode);
    modeRef.current = mode;
    const id = liveActiveIdRef.current;
    // Remembered for the chat's own folder, which may not be the one open in the app.
    savePermissionMode(mode, liveChatsRef.current.find((c) => c.id === id)?.workspace ?? loadWorkspace());
    if (id) setChats((prev) => prev.map((c) => (c.id === id && c.permissionMode !== mode ? { ...c, permissionMode: mode } : c)));
  }, [allowPermissionBypass, liveActiveIdRef, liveChatsRef, promptEnableBypass, setChats]);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    saveSelectedModel(model);
    const id = liveActiveIdRef.current;
    if (id) setChats((prev) => prev.map((c) => (c.id === id && c.model !== model ? { ...c, model } : c)));
  }, [liveActiveIdRef, setChats]);

  // SendToSession compares the mode of the session it writes to with the sender's.
  useEffect(() => {
    setChatModeResolver(chatModeOf);
    return () => setChatModeResolver(null);
  }, [chatModeOf]);

  const permissionModeChangeRef = useRef(handlePermissionModeChange);
  useEffect(() => { permissionModeChangeRef.current = handlePermissionModeChange; }, [handlePermissionModeChange]);
  useEffect(() => {
    const chat = activeId ? liveChatsRef.current.find((c) => c.id === activeId) : undefined;
    setSelectedModel(chat?.model ?? loadSelectedModel());
    const mode = chat?.permissionMode ?? loadPermissionMode(loadWorkspace());
    setPermissionMode(mode);
    modeRef.current = mode;
    if (mode !== "skip") return;
    let alive = true;
    void getMergedSettings().then(() => {
      if (alive && !bypassAllowed() && modeRef.current === "skip") permissionModeChangeRef.current("acceptEdits");
    });
    return () => { alive = false; };
  }, [activeId, liveChatsRef]);
  useEffect(() => {
    let ready = false;
    const enforceBypassPolicy = () => {
      if (!ready) return;
      if (!bypassAllowed() && modeRef.current === "skip") {
        permissionModeChangeRef.current("acceptEdits");
      }
    };
    const unsubscribe = subscribeSettings(enforceBypassPolicy);
    void getMergedSettings().then(() => {
      ready = true;
      enforceBypassPolicy();
    });
    return () => {
      ready = false;
      unsubscribe();
    };
  }, []);

  return { selectedModel, permissionMode, modeRef, chatModeOf, handlePermissionModeChange, handleModelChange };
}
