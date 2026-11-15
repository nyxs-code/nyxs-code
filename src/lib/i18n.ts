import { useEffect, useState } from "react";
import type { LangCode, Translations } from "../locales/types";
import enUS from "../locales/en-US";
import frFR from "../locales/fr-FR";
import deDE from "../locales/de-DE";
import hiIN from "../locales/hi-IN";
import idID from "../locales/id-ID";
import itIT from "../locales/it-IT";
import jaJP from "../locales/ja-JP";
import koKR from "../locales/ko-KR";
import ptBR from "../locales/pt-BR";
import esES from "../locales/es-ES";
import { describeError } from "./ipc";
import { LocalizedError } from "./localizedError";

export type { LangCode, Translations } from "../locales/types";

export const DEFAULT_LANG: LangCode = "en-US";
export const LANG_KEY = "nyxs.language.v1";
export const LANG_EVENT = "nyxs:language-changed";

export const LANGUAGES: { code: LangCode; label: string }[] = [
  { code: "en-US", label: "English (United States)" },
  { code: "fr-FR", label: "Français (France)" },
  { code: "de-DE", label: "Deutsch (Deutschland)" },
  { code: "hi-IN", label: "हिन्दी (भारत)" },
  { code: "id-ID", label: "Indonesia (Indonesia)" },
  { code: "it-IT", label: "Italiano (Italia)" },
  { code: "ja-JP", label: "日本語 (日本)" },
  { code: "ko-KR", label: "한국어 (대한민국)" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "es-ES", label: "Español (España)" },
];

const TRANSLATIONS: Record<LangCode, Translations> = {
  "en-US": enUS,
  "fr-FR": frFR,
  "de-DE": deDE,
  "hi-IN": hiIN,
  "id-ID": idID,
  "it-IT": itIT,
  "ja-JP": jaJP,
  "ko-KR": koKR,
  "pt-BR": ptBR,
  "es-ES": esES,
};

export function getTranslations(code: string): Translations {
  return TRANSLATIONS[code as LangCode] ?? TRANSLATIONS[DEFAULT_LANG];
}

/** `describeError` in the language the app is showing right now, for code outside React. */
export function localizedError(e: unknown): string {
  const t = getTranslations(getLanguage());
  return e instanceof LocalizedError ? e.text(t) : describeError(e, t);
}

export function getLanguage(): LangCode {
  // Outside a page (node tests, headless helpers) there is no storage: the default applies.
  const code = typeof localStorage === "undefined" ? null : localStorage.getItem(LANG_KEY);
  return code && code in TRANSLATIONS ? (code as LangCode) : DEFAULT_LANG;
}

export function setLanguage(code: LangCode): void {
  localStorage.setItem(LANG_KEY, code);
  window.dispatchEvent(new CustomEvent(LANG_EVENT));
}

export function useTranslations(): Translations {
  const [code, setCode] = useState<LangCode>(getLanguage);
  useEffect(() => {
    const sync = () => setCode(getLanguage());
    window.addEventListener(LANG_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(LANG_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return TRANSLATIONS[code];
}
