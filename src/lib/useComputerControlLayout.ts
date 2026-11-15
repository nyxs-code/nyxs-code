import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * While the agent uses the computer the window steps aside to a narrow strip
 * (`src-tauri/src/computer/compact.rs`): the sidebar closes so the chat fills it, and opens again
 * as the user had it once the agent lets go.
 */
export function useComputerControlLayout(sidebarOpen: boolean, setSidebarOpen: Dispatch<SetStateAction<boolean>>): void {
  const openRef = useRef(sidebarOpen);
  useEffect(() => {
    openRef.current = sidebarOpen;
  });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let before: boolean | null = null;
    const unlisten = listen<boolean>("computer-control", (e) => {
      if (e.payload) {
        if (before === null) before = openRef.current;
        setSidebarOpen(false);
      } else if (before !== null) {
        setSidebarOpen(before);
        before = null;
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [setSidebarOpen]);
}
