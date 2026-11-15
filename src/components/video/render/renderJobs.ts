import { useSyncExternalStore } from "react";
import { onRenderProgress, render, renderCancel, still, type RenderOptions, type RenderProgress } from "@/lib/video/videoApi";

export type RenderStage = RenderProgress["stage"] | "queued";

/** One render in the queue, as the panel shows it. */
export interface RenderJob {
  /** The backend's render id; a local id until the backend answers (and for stills). */
  id: string;
  workspace: string;
  slug: string;
  label: string;
  outputName: string;
  stage: RenderStage;
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  etaSecs?: number;
  encoder?: string;
  outputPath?: string;
  error?: string;
  startedAt: number;
}

let jobs: RenderJob[] = [];
const listeners = new Set<() => void>();
let listening = false;
/** Events for a render id the queue doesn't know yet (`render()` hasn't answered). */
const early = new Map<string, Partial<RenderJob>>();

function emit() {
  for (const l of [...listeners]) l();
}

function patch(id: string, p: Partial<RenderJob>) {
  let changed = false;
  jobs = jobs.map((j) => {
    if (j.id !== id) return j;
    changed = true;
    return { ...j, ...p };
  });
  if (changed) emit();
}

/** Progress events for every render of the app: one listener, attached on first use. */
function ensureListening() {
  if (listening) return;
  listening = true;
  void onRenderProgress((e) => {
    const p: Partial<RenderJob> = {
      stage: e.stage,
      progress: e.progress,
      renderedFrames: e.renderedFrames,
      totalFrames: e.totalFrames,
      etaSecs: e.etaSecs ?? undefined,
      encoder: e.encoder ?? undefined,
      outputPath: e.outputPath ?? undefined,
      error: e.error ?? undefined,
    };
    if (jobs.some((j) => j.id === e.renderId)) patch(e.renderId, p);
    else early.set(e.renderId, { ...early.get(e.renderId), ...p });
  }).catch(() => {
    listening = false;
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The renders started from the panel during this run of the app, newest first. */
export function useRenderJobs(): RenderJob[] {
  return useSyncExternalStore(subscribe, () => jobs, () => jobs);
}

export function isRenderActive(job: RenderJob): boolean {
  return job.stage === "queued" || job.stage === "bundling" || job.stage === "rendering" || job.stage === "encoding";
}

/** The renders of this run of the app, for a caller outside React. */
export function getRenderJobs(): RenderJob[] {
  return jobs;
}

/** Resolves with the render's id (the backend's) once it started. */
export async function startRender(workspace: string, slug: string, label: string, opts: RenderOptions): Promise<string> {
  ensureListening();
  const localId = `local-${Date.now().toString(36)}`;
  jobs = [
    { id: localId, workspace, slug, label, outputName: opts.outputName, stage: "queued", progress: 0, renderedFrames: 0, totalFrames: 0, startedAt: Date.now() },
    ...jobs,
  ];
  emit();
  try {
    const renderId = await render(workspace, slug, opts);
    // Progress may have arrived for the real id before this answer.
    patch(localId, { id: renderId, ...early.get(renderId) });
    early.delete(renderId);
    return renderId;
  } catch (e) {
    patch(localId, { stage: "error", error: String(e) });
    throw e;
  }
}

/** A single PNG of one frame: the "PNG frame" format of the render dialog. */
export async function startStill(workspace: string, slug: string, label: string, compositionId: string, frame: number, outputName: string): Promise<void> {
  const localId = `still-${Date.now().toString(36)}`;
  jobs = [
    { id: localId, workspace, slug, label, outputName, stage: "rendering", progress: 0, renderedFrames: 0, totalFrames: 1, startedAt: Date.now() },
    ...jobs,
  ];
  emit();
  try {
    const path = await still(workspace, slug, compositionId, frame, outputName);
    patch(localId, { stage: "done", progress: 1, renderedFrames: 1, outputPath: path });
  } catch (e) {
    patch(localId, { stage: "error", error: String(e) });
    throw e;
  }
}

export async function cancelRender(id: string): Promise<void> {
  if (id.startsWith("local-") || id.startsWith("still-")) {
    patch(id, { stage: "cancelled" });
    return;
  }
  await renderCancel(id);
  // The backend confirms with a "cancelled" event; mark it now so the button reacts at once.
  patch(id, { stage: "cancelled" });
}

export function clearFinished(): void {
  jobs = jobs.filter(isRenderActive);
  emit();
}
