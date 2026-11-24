/** Asks the consent dialog to show for a project now, even if it was answered before
 *  (Settings › Privacy › "Index now", or turning semantic search on). */
const ASK_EVENT = "nyxs:rag-consent-ask";
/** Sent after a project's answer changes, so Settings shows it at once. */
const CHANGED_EVENT = "nyxs:rag-consent-changed";

export function askRagConsent(workspace: string): void {
  window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: workspace }));
}

export function onRagConsentAsk(fn: (workspace: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener(ASK_EVENT, h);
  return () => window.removeEventListener(ASK_EVENT, h);
}

export function notifyRagConsentChanged(): void {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function onRagConsentChanged(fn: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, fn);
  return () => window.removeEventListener(CHANGED_EVENT, fn);
}
