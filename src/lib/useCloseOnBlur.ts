import { useEffect, useRef } from "react";

/** Closes a menu when the window loses focus. A click on the browser panel's page goes to its
 *  native webview, never to the menu's invisible click-outside layer: the app only sees its
 *  window blur. */
export function useCloseOnBlur(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onBlur = () => closeRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [open]);
}
