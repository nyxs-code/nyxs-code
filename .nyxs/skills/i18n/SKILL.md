---
name: i18n
description: Keep Nyxs fully localized — author code/comments/docs in English (base locale), and whenever a user-facing string is created or edited, add its translation to EVERY locale file.
when_to_use: Use on EVERY task that creates or edits files in this project (Nyxs). Two blocking rules — (1) code, comments, identifiers and docs stay in English; (2) any new or changed user-facing UI string must be added to the i18n layer and translated into all supported languages. Leaving a hardcoded string untranslated, or a locale missing a key, is a defect to fix.
---

# i18n / localization convention

Nyxs ships in multiple languages through a typed i18n layer. The **source code**
stays in English (one authoring language), but every **user-facing string** must
live in the locale files and be translated into **all** supported languages —
not just English. This skill replaces the former "english-only" rule: English is
now the *base locale*, not the only language.

## The i18n layer

- **`src/locales/types.ts`** — the `Translations` interface. Keys are grouped by
  UI surface (e.g. `sidebar`, `settings`). Adding a key here forces every locale
  file to provide it (TypeScript fails the build otherwise — this is the safety net).
- **One file per language**, each `export default` a full `Translations` object:
  `en-US` (base), `fr-FR`, `de-DE`, `hi-IN`, `id-ID`, `it-IT`, `ja-JP`, `ko-KR`,
  `pt-BR`, `es-ES`. **All 10 must stay in sync.**
- **`src/lib/i18n.ts`** — registry + `useTranslations()` hook. Components read
  strings via this hook; they do not hardcode literals.

## What to do — adding or editing a user-facing string

When you introduce or change any label, button, placeholder, tooltip, menu item,
heading, empty state, toast, or error/permission message shown in the app:

1. **Add/rename the key** in `src/locales/types.ts` under the right group (or add
   a new group). Use a clear English camelCase key (e.g. `viewChangelog`).
2. **Add the translated value to EVERY locale file** — all 10 — with a faithful,
   natural translation for that language. Do not copy the English text into the
   other locales as a placeholder; translate it. (`en-US` holds the English text.)
3. **Render it via the hook**: `const t = useTranslations();` then `t.group.key`
   — never a hardcoded literal in the component.
4. **Run `tsc -b`** to confirm no locale is missing the key.

When you **edit** an existing string's wording, update it in **all** locale files,
not just one — otherwise the languages drift apart.

## Language rules for everything else (still English)

- **Code**: identifiers (variables, functions, components, types), enum values,
  file and folder names → English.
- **Comments and JSDoc** → English.
- **Docs**: README, inline docs, `.md`, agent-facing text (system prompt, tool
  descriptions, skill files) → English.
- **Commit messages and PR descriptions** → English.

## Do NOT

- Do **not** hardcode a user-facing string directly in a component. Route it
  through the locale files + `useTranslations()`.
- Do **not** add a key to one locale and forget the others — every locale must
  carry every key (the type-check enforces this; honor it, don't `// @ts-ignore`).
- Do **not** leave the non-English locales as untranslated English copies. A
  missing translation is the same defect as a hardcoded string.
- Do **not** mass-migrate the whole codebase in one unrelated change. Localize
  the strings you're already touching, plus anything the user explicitly asks for.
- Do **not** rename public/config keys, API fields, or storage keys to anglicize
  them if that breaks persisted data or external contracts — flag them instead.

## Tips for localizable strings

- Prefer a single clear literal per message over text spliced from fragments, so
  it maps to one key.
- Use templated messages for inserted values (`` `Added ${name}` ``), and add the
  key as a function/format in every locale rather than concatenating display text.
- Don't depend on a string's exact characters for logic (compare against
  enums/ids, not against display text).
