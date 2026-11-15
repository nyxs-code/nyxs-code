export type DesktopOs = "windows" | "macos" | "linux";

/** The OS Nyxs runs on, from the webview's user agent (WebView2 says "Windows", WKWebView
 *  "Macintosh"). The macOS version can't be read here: WKWebView freezes it at 10_15_7. */
export function desktopOs(): DesktopOs {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}
