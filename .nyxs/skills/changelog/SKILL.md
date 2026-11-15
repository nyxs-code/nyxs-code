---
name: changelog
description: Generate a curated, user-facing changelog entry from recent commits — client-facing changes only, with theme-matched icons.
when_to_use: When preparing release notes, adding a new version to the changelog, or when the `release` skill needs the "what's new" entry. Use before tagging a release.
---

# Write a user-facing changelog entry

The changelog in `src/lib/changelog.ts` is the SINGLE SOURCE OF TRUTH for what
users see: the in-app "What's new" modal AND the auto-update card both read it,
and the release CI (`scripts/release-notes.mjs`) turns it into the published
update notes. So this file must contain ONLY client-facing changes — anything
internal must never reach it.

Everything in this file is in English (project convention — see the `i18n` skill).

## 1. Gather the changes since the last release

```bash
git describe --tags --abbrev=0          # last tag, e.g. v0.2.7
git log <last-tag>..HEAD --pretty=format:%s   # commit subjects since then
```

## 2. Classify — publish client-facing, drop internal

Sort each commit into one of the changelog buckets, or DROP it:

- `added` — new user-facing features (`feat:` commits).
- `fixed` — bug fixes the user could notice (`fix:` commits).
- `improved` — better behavior of existing features (`perf:`, UX polish).
- **DROP (never publish)** — internal-only work: refactors, tests, CI/build,
  dependency bumps, docs, tooling, dev-experience changes, anything tagged
  `[internal]`/`[no-notes]`, or any change a user would never see or feel.

When a commit is ambiguous, lean toward DROPPING it, or ask the user. The bar is:
"would a user notice or care?" If not, it doesn't go in.

## 3. Offer the user the choice

Present the candidate entries grouped (New / Fixed / Improved) and the ones you
plan to DROP as internal. Let the user confirm, reword, add, or move items
between buckets before you write anything. The user has final say over what ships.

## 4. Write the entries

- Short, plain, English, one sentence each. No version numbers or commit hashes.
- For `added`/`improved`, write as `Label: description` or `**Title** — description`
  so the update card can split a bold title from its description. Example:
  `"Voice input: hold the mic button to talk and have it transcribed into chat."`
- Lead each highlight with the word that matches its theme, so the update card
  auto-picks a fitting icon (see vocabulary below).

### Icon vocabulary (auto-picked from wording)

The update card chooses the highlight icon from keywords in the text — no manual
icon field. Phrase the entry so the relevant word appears:

| Theme | Trigger words | Icon |
|-------|---------------|------|
| Terminal / shell | terminal, pwsh, powershell, shell, command | terminal |
| Preview / panels | preview, panel, view | panel |
| Agents | agent, subagent | bot |
| Voice | voice, mic, transcribe | mic |
| Theme / colors | theme, color, dark, light | palette |
| Files | file, folder, explorer | folder |
| Search / filter | search, grep, filter | search |
| Updates | update, auto-update | refresh |
| Chat | chat, message, conversation | message |
| Speed | speed, fast, overclock, performance | gauge |
| Grouping | group, layer | layers |
| (anything else) | — | sparkle (default) |

If a new recurring theme needs its own icon, add a rule to `ICON_RULES` in
`src/components/UpdateAlert.tsx`.

## 5. Insert into the changelog

Add a NEW entry at the TOP of the `CHANGELOG` array in `src/lib/changelog.ts`:

```ts
{
  version: "0.3.0",              // matches the release tag minus the leading v
  date: "June 3, 2026",         // human date, today
  added: [
    "Terminal PowerShell: a real interactive shell with pwsh 7+, colors and line editing.",
  ],
  improved: [
    "Grouped views: agents and commands now collapse in the chat for a cleaner conversation.",
  ],
  fixed: [
    "Fixed an infinite loop when the agent tried to fix ESLint errors.",
  ],
},
```

Omit any bucket that has no entries. Keep newest-first order.

After this, the `release` skill tags and ships it; the CI publishes exactly
these notes to users.
