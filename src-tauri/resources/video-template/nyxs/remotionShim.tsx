// Stand-in for "remotion" inside the project's own code when nyxs/serve.mjs bundles its entry
// for the player. Everything is the real remotion module except <Composition>, <Still> and
// registerRoot, which only record what the project registers, so the player can list and preview
// the project's compositions without Remotion's internal registry (it changes between versions).

import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

export * from "remotion";

/** A composition the project registers in its Root, as the player needs it. */
export type CollectedComposition = {
  id: string;
  width?: number;
  height?: number;
  fps?: number;
  durationInFrames?: number;
  defaultProps: Record<string, unknown>;
  component?: React.ComponentType<Record<string, unknown>>;
  lazyComponent?: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>;
  calculateMetadata?: (options: Record<string, unknown>) => unknown;
  still: boolean;
  folder: string | null;
};

const collected = new Map<string, CollectedComposition>();
let root: React.ComponentType | null = null;
const FolderContext = React.createContext<string | null>(null);

type CompositionProps = {
  id: string;
  width?: number;
  height?: number;
  fps?: number;
  durationInFrames?: number;
  defaultProps?: Record<string, unknown>;
  component?: React.ComponentType<Record<string, unknown>>;
  lazyComponent?: CollectedComposition["lazyComponent"];
  calculateMetadata?: CollectedComposition["calculateMetadata"];
};

function record(props: CompositionProps, still: boolean, folder: string | null) {
  collected.set(props.id, {
    id: props.id,
    width: props.width,
    height: props.height,
    fps: still ? (props.fps ?? 30) : props.fps,
    durationInFrames: still ? 1 : props.durationInFrames,
    defaultProps: props.defaultProps ?? {},
    component: props.component,
    lazyComponent: props.lazyComponent,
    calculateMetadata: props.calculateMetadata ?? undefined,
    still,
    folder,
  });
}

export const Composition = (props: CompositionProps): null => {
  record(props, false, React.useContext(FolderContext));
  return null;
};

export const Still = (props: CompositionProps): null => {
  record(props, true, React.useContext(FolderContext));
  return null;
};

export const Folder = ({ name, children }: { name: string; children?: React.ReactNode }) => {
  const parent = React.useContext(FolderContext);
  return <FolderContext.Provider value={parent ? `${parent}/${name}` : name}>{children}</FolderContext.Provider>;
};

export const registerRoot = (comp: React.ComponentType) => {
  root = comp;
};

/** Renders the registered Root off-screen once and returns the compositions it declared. */
export function collectCompositions(): CollectedComposition[] {
  if (!root) throw new Error("The project's entry did not call registerRoot().");
  collected.clear();
  const host = document.createElement("div");
  const reactRoot = createRoot(host);
  const Root = root;
  try {
    flushSync(() => reactRoot.render(<Root />));
  } finally {
    reactRoot.unmount();
  }
  return [...collected.values()];
}
