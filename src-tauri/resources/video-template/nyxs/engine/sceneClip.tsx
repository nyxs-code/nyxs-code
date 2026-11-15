import React, { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";
import { importScene } from "./sceneLoader";
import { sceneModuleName } from "./schema";
import type { SceneClip } from "./schema";

type SceneModule = Record<string, unknown>;

const modules = new Map<string, Promise<SceneModule>>();

function loadScene(file: string): Promise<SceneModule> {
  const name = sceneModuleName(file);
  let p = modules.get(name);
  if (!p) {
    p = importScene(name).catch((err: unknown) => {
      modules.delete(name);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not load scene "scenes/${name}.tsx": ${reason}`);
    });
    modules.set(name, p);
  }
  return p;
}

type State = { key: string; component?: React.ComponentType<Record<string, unknown>>; error?: Error };

function pickExport(mod: SceneModule, clip: SceneClip): React.ComponentType<Record<string, unknown>> {
  const exported = mod[clip.exportName];
  const isComponent =
    typeof exported === "function" || (typeof exported === "object" && exported !== null && "$$typeof" in exported);
  if (!isComponent) {
    const names = Object.keys(mod).filter((k) => typeof mod[k] === "function" || (typeof mod[k] === "object" && mod[k] !== null));
    throw new Error(
      `Scene "scenes/${sceneModuleName(clip.file)}.tsx" has no component export "${clip.exportName}". Exports: ${names.join(", ") || "none"}.`,
    );
  }
  return exported as React.ComponentType<Record<string, unknown>>;
}

/** Renders a scene (the project's scenes/ or a built-in one), holding the render until it is loaded. */
export const SceneContent: React.FC<{ clip: SceneClip }> = ({ clip }) => {
  const key = `${sceneModuleName(clip.file)}#${clip.exportName}`;
  const [state, setState] = useState<State>({ key: "" });
  const [initialHandle] = useState(() => delayRender(`Loading scene ${clip.file}`, { timeoutInMilliseconds: 60_000 }));
  const [initialUsed] = useState(() => ({ current: false }));

  useEffect(() => {
    const handle = initialUsed.current ? delayRender(`Loading scene ${clip.file}`) : initialHandle;
    initialUsed.current = true;
    let cancelled = false;
    loadScene(clip.file)
      .then((mod) => {
        if (!cancelled) setState({ key, component: pickExport(mod, clip) });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ key, error: err instanceof Error ? err : new Error(String(err)) });
      })
      .finally(() => continueRender(handle));
    return () => {
      cancelled = true;
    };
    // Reload only when the file or export changes, not when props change.
  }, [key]);

  if (state.key === key && state.error) throw state.error;
  if (state.key !== key || !state.component) return null;
  const Component = state.component;
  return <Component {...(clip.props ?? {})} />;
};
