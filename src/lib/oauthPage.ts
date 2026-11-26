import { getLanguage, getTranslations } from "@/lib/i18n";

/** What the browser tab shows when a sign-in comes back to the app (`oauth_wait` writes it):
 *  Nyxs next to the service that was connected, and the outcome. */
export interface OAuthCallbackPage {
  connectedTitle: string;
  connectedText: string;
  failedTitle: string;
  failedText: string;
  /** The service's logo as SVG markup; without one, its initial in its colour. */
  serviceIcon?: string;
  serviceInitial?: string;
  serviceColor?: string;
  /** Where to send the tab, followed by the server's `done` key, instead of showing this page. */
  doneUrl?: string;
}

/** Google's "G", for signing in to Nyxs. */
const GOOGLE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';

/** The page for signing in to Nyxs with Google. */
export function signInCallbackPage(): OAuthCallbackPage {
  const t = getTranslations(getLanguage()).oauthPage;
  return {
    connectedTitle: t.signedInTitle,
    connectedText: t.connectedText,
    failedTitle: t.signInFailedTitle,
    failedText: t.failedText,
    serviceIcon: GOOGLE_ICON,
  };
}

/** The page for connecting a connector, with its logo (a path to the app's own SVG) when it has
 *  one. `#e5e5e5`, the catalog's colour for black logos, would vanish as an initial on the page. */
export async function connectorCallbackPage(
  name: string,
  look: { logo?: string; color?: string } = {},
): Promise<OAuthCallbackPage> {
  const t = getTranslations(getLanguage()).oauthPage;
  const page: OAuthCallbackPage = {
    connectedTitle: t.connectedTitle.replace("{name}", name),
    connectedText: t.connectedText,
    failedTitle: t.failedTitle.replace("{name}", name),
    failedText: t.failedText,
    serviceInitial: name.trim().charAt(0),
  };
  if (look.color && look.color.toLowerCase() !== "#e5e5e5") page.serviceColor = look.color;
  const icon = look.logo ? await logoSvg(look.logo) : null;
  if (icon) page.serviceIcon = icon;
  return page;
}

/** A logo from the app's own files. Single-colour logos draw in `currentColor`, which an `<img>`
 *  renders black: on the page's dark tiles they take its text colour instead. */
async function logoSvg(path: string): Promise<string | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const svg = await res.text();
    return svg.trimStart().startsWith("<svg") ? svg.replaceAll("currentColor", "#ececec") : null;
  } catch {
    return null;
  }
}
