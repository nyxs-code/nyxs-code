export const SITE_BASE = "https://nyxs.dev";
export const GITHUB_REPO_URL = "https://github.com/nyxs-code/nyxs-code";

export type SitePage = "docs" | "quickstart" | "shortcuts" | "blog" | "privacy" | "terms";

const PATHS: Record<SitePage, string> = {
  docs: "/docs/",
  quickstart: "/docs/quickstart/",
  shortcuts: "/docs/keyboard-shortcuts/",
  blog: "/blog/",
  privacy: "/legal/privacy/",
  terms: "/legal/terms/",
};

/** Languages the site has a translated copy of, under `/<lang>/`; English lives at the root. */
const SITE_LANGS = new Set(["es", "fr", "de", "hi", "id", "it", "ja", "ko", "pt"]);

/** A nyxs.dev page in the app's language (`es-ES` → `/es/docs/`), English for any other. */
export function siteUrl(page: SitePage, appLanguage: string): string {
  const lang = appLanguage.split("-")[0].toLowerCase();
  const prefix = SITE_LANGS.has(lang) ? `/${lang}` : "";
  return `${SITE_BASE}${prefix}${PATHS[page]}`;
}
