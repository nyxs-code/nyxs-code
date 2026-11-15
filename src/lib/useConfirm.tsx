import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, type ConfirmOptions } from "@/components/ConfirmDialog";

/**
 * Promise-based replacement for `window.confirm`/`window.alert`: `await confirm({...})` resolves
 * true on confirm and false on cancel or Escape. Render the returned element anywhere.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  // The open question's answer, so a newer question or the owner going away can settle it: an
  // `await confirm()` left without an answer would hang its caller.
  const openRef = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => () => openRef.current?.(false), []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        openRef.current?.(false);
        openRef.current = resolve;
        setPending({ ...options, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    if (openRef.current === pending?.resolve) openRef.current = null;
    setPending(null);
  };

  const element = pending ? (
    <ConfirmDialog {...pending} onConfirm={() => close(true)} onCancel={() => close(false)} />
  ) : null;

  return [confirm, element];
}
