import type { ProviderId } from "./models";

/** When each provider's models were last read this run. Picking it again within this long shows
 *  the list it has without reading it again; a read never shows a spinner over a list there is,
 *  it updates it in place (zeron's stale-while-revalidate). */
const MODELS_TTL_MS = 10 * 60 * 1000;
const readAt = new Map<ProviderId, number>();

export function modelsAreFresh(id: ProviderId): boolean {
  return Date.now() - (readAt.get(id) ?? 0) < MODELS_TTL_MS;
}

export function markModelsRead(id: ProviderId): void {
  readAt.set(id, Date.now());
}

/** Its list is read again next time (connected again, or in tests). */
export function forgetModelsRead(id?: ProviderId): void {
  if (id) readAt.delete(id);
  else readAt.clear();
}
