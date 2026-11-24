import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * While the agent uses the computer the window steps aside to a narrow strip
 * (`src-tauri/src/computer/compact.rs`): the sidebar closes so the chat fills it, and opens again
 * as the user had it once the agent lets go. Returns whether the agent has the computer, so the
 * side panel steps aside too: it is never narrower than 600 px, so in the strip it pushed the
 * chat out and its page stuck out past the window.
 */
export function useComputerControlLayout(sidebarOpen: boolean, setSidebarOpen: Dispatch<SetStateAction<boolean>>): boolean {
  const openRef = useRef(sidebarOpen);
  const [controlled, setControlled] = useState(false);
  useEffect(() => {
    openRef.current = sidebarOpen;
  });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let before: boolean | null = null;
    const unlisten = listen<boolean>("computer-control", (e) => {
      setControlled(e.payload);
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
  return controlled;
}
