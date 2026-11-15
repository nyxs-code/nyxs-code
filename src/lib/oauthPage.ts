import { getLanguage, getTranslations } from "@/lib/i18n";

/** What the browser tab shows when a sign-in comes back to the app (`oauth_wait` writes it). */
export interface OAuthCallbackPage {
  connectedTitle: string;
  connectedText: string;
  failedTitle: string;
  failedText: string;
}

/** The callback page's texts in the app's language. */
export function oauthCallbackPage(): OAuthCallbackPage {
  const t = getTranslations(getLanguage()).oauthPage;
  return {
    connectedTitle: t.connectedTitle,
    connectedText: t.connectedText,
    failedTitle: t.failedTitle,
    failedText: t.failedText,
  };
}
