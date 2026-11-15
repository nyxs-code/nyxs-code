import { useCallback, useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { desktopOs } from "@/lib/desktopOs";

export interface ComputerPermissions {
  platform: "windows" | "macos" | "linux";
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
}

export type ComputerPermissionKind = "accessibility" | "screenRecording";

/** What computer use needs from the OS (`computer_permissions`). Windows needs nothing, so it
 *  isn't asked there; elsewhere it's read on mount and again whenever the window regains focus,
 *  which is when the user comes back from System Settings. `null` until known, or when the
 *  backend can't answer (then Settings shows nothing extra). */
export function useComputerPermissions() {
  const ask = desktopOs() !== "windows";
  const [perms, setPerms] = useState<ComputerPermissions | null>(null);
  const refresh = useCallback(
    () =>
      ask
        ? invoke<ComputerPermissions>("computer_permissions").then(setPerms, () => setPerms(null))
        : Promise.resolve(),
    [ask],
  );
  useEffect(() => {
    if (!ask) return;
    invoke<ComputerPermissions>("computer_permissions").then(setPerms, () => setPerms(null));
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ask, refresh]);
  const request = useCallback(async (kind: ComputerPermissionKind) => {
    await invoke("computer_request_permission", { kind }).catch(() => undefined);
    await refresh();
  }, [refresh]);
  return { perms, request, refresh };
}
