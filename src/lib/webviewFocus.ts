/**
 * Focuses `el` and makes sure the keys reach it. In Tauri the keyboard can stay with another
 * webview (the built-in browser's) while the DOM already shows `el` focused, with no caret:
 * the window and this webview take the keyboard back first.
 */
export async function focusInWebview(el: HTMLElement | null): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const [{ getCurrentWindow }, { getCurrentWebview }] = await Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/webview"),
    ]);
    await getCurrentWindow().setFocus().catch(() => undefined);
    await getCurrentWebview().setFocus().catch(() => undefined);
  }
  el?.focus();
}
