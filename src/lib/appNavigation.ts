import { useCallback, useState } from "react";
import type { Section } from "@/lib/sections";

export type AppNavSnapshot = {
  settingsOpen: boolean;
  settingsSection?: string;
  section: Section;
};

export function snapshotsEqual(a: AppNavSnapshot, b: AppNavSnapshot): boolean {
  return (
    a.settingsOpen === b.settingsOpen &&
    a.settingsSection === b.settingsSection &&
    a.section === b.section
  );
}

export function useAppNavigation(
  initial: AppNavSnapshot,
  apply: (snap: AppNavSnapshot) => void,
) {
  const [state, setState] = useState({ stack: [initial], index: 0 });

  const navigate = useCallback(
    (snap: AppNavSnapshot) => {
      apply(snap);
      setState(({ stack, index }) => {
        const base = stack.slice(0, index + 1);
        const last = base[base.length - 1];
        if (snapshotsEqual(last, snap)) return { stack, index };
        return { stack: [...base, snap], index: base.length };
      });
    },
    [apply],
  );

  const goBack = useCallback(() => {
    setState(({ stack, index }) => {
      if (index <= 0) return { stack, index };
      const next = index - 1;
      apply(stack[next]);
      return { stack, index: next };
    });
  }, [apply]);

  const goForward = useCallback(() => {
    setState(({ stack, index }) => {
      if (index >= stack.length - 1) return { stack, index };
      const next = index + 1;
      apply(stack[next]);
      return { stack, index: next };
    });
  }, [apply]);

  return {
    canGoBack: state.index > 0,
    canGoForward: state.index < state.stack.length - 1,
    navigate,
    goBack,
    goForward,
  };
}
