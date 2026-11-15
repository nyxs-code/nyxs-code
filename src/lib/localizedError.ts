import type { Translations } from "@/locales/types";

/**
 * An error the UI shows from the locales (`pluginErrors[key]`, its `{param}`s filled in), while
 * `message` stays the English text the agent and the logs read. `localizedError` picks it up.
 */
export class LocalizedError extends Error {
  readonly key: keyof Translations["pluginErrors"];
  readonly params: Record<string, string>;

  constructor(
    key: keyof Translations["pluginErrors"],
    params: Record<string, string>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.key = key;
    this.params = params;
  }

  /** The text in the language of `t`, or the English message when it has no template. */
  text(t: Pick<Translations, "pluginErrors">): string {
    const template = t.pluginErrors[this.key];
    if (!template) return this.message;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => this.params[name] ?? whole);
  }
}
