---
name: nyxs-update-card
description: How to write the animated slides of the Nyxs update card (the card in the sidebar that offers a new version, one demo per novelty) and check that they fit. Use when releasing a version, when the user asks for the update card's animations, demos or "novedades" for a version, or when changing src/components/update/ or src/lib/updateCard.ts.
---

# The update card

When a new version is out, the sidebar shows a card that offers it: one slide per novelty,
each with a small animated demo on top (the mascot on a message box, a reply with the
microphone, a page in the browser…), a title, a description, dots to move between slides,
and the "Update" button that turns into the download's progress.

**The card is drawn by the version that is still installed**, not by the new one. So a demo
can't be new code: it is data, a `card` in the release's `src/lib/changelog.ts` entry, which
`scripts/release-notes.mjs` hides at the end of the release notes as
`<!-- nyxs-card {...} -->`. The installed app draws it with the scenes it knows. You compose
the animation from a fixed catalog of scenes; you don't write HTML, CSS or components.

Files: format and checks `src/lib/updateCard.ts`; scenes `src/components/update/CardScene.tsx`;
card `src/components/update/UpdateCard.tsx`; a complete example in every scene but terminal
and icon: `src/lib/updateCardSample.ts` (the 0.8.53 card). Read it before writing one.

## There is very little room

At the narrowest sidebar (224 px) the card is about 236 px wide:

- **Demo stage:** about 236 × 120 px. Each scene has a fixed layout made for it.
- **Title:** one line at 14 px: about 26 Latin characters (fewer in German or Hindi).
- **Description:** three lines at 12.5 px: about 85–95 Latin characters.
- **Small texts inside demos** (a status line, a typed phrase, a quote): one line of 130–200 px.

Nothing scrolls and nothing grows. A text that doesn't fit gets cut with "…" or clamped, and
that is a bug: the audit (below) measures every text in every language and fails on it. The
character caps in `CARD_LIMITS` are only a first filter; the measurement decides.

On Windows the audit draws the narrowest sidebar 12 px narrower than it really is (212 px):
the same font comes out up to ~5% wider on Linux and macOS, so a text that only just fits on
this PC is cut on theirs. CI measures on Linux, already that wide, with 4 px. Leave room;
don't fight for the last pixel.

## Writing a card

1. Read the release's changelog entry (and `git log <last tag>..HEAD`). Pick **3–5 novelties
   a user notices**, most visible first. Improvements and fixes without a demo of their own
   go together in a last `list` slide ("And also"), at most 2 items. 6 slides at most.
2. For each, pick the scene that *shows* it working (catalog below). Prefer the mascot or the
   message box when the novelty lives there; `icon` only when nothing else fits.
3. Write `title` and `desc` in **all 10 languages** (`en-US`, `es-ES`, `fr-FR`, `de-DE`,
   `it-IT`, `pt-BR`, `id-ID`, `ja-JP`, `ko-KR`, `hi-IN`). What the user notices, not the code;
   no file names, flags or internal names in titles. Short words: German compounds and Hindi
   phrases are what overflow first. Write each language natively, not word for word.
4. Add it as `card: { v: 1, slides: [...] }` to the entry in `src/lib/changelog.ts`. It must be
   a plain literal (no variables, spreads, `as const` or comments inside): the release script
   evaluates the array as JavaScript.
5. Check it (next section) and fix until everything passes.

## Checking it

1. **Format and caps:** `node node_modules/vitest/vitest.mjs run src/lib/__tests__/updateCard.test.ts`.
   It fails on anything the app would drop or replace (unknown pose, icon or kind, empty text,
   too many items), a missing language, or a text over its cap.
2. **Look at it:** with a dev server running (`tauri dev` on :1420, or `npm run dev`), open
   `http://localhost:1420/dev/update-card.html?card=<version>&width=224` in the built-in browser.
   - Query: `card` (`sample`, `latest`, or a version), `lang`, `width` (the sidebar's: 224
     narrowest, 288 default), `status` (`available`, `downloading`, `ready`, `error`), and
     `slide` (0-based) + `phase` (the scene's step) to hold one moment still.
   - Without `slide` it plays like the app. Screenshot each slide at 224 px in Spanish and in
     German; judge it as a designer: is the demo clear at a glance, does it show the novelty?
3. **Measure it:** in that page run `await window.__updateCard.audit(["<version>"])` (with the
   browser tool's eval). It draws every language × both widths × every slide × every step ×
   every install state and returns what is cut or sticks out, with where. It must return `[]`.
   CI runs the same audit for every card: `npx playwright test e2e/tests/updateCard.spec.ts --workers=1`.
4. **Fixing:** shorten the text in the language that fails (another word, fewer details).
   Never change the card's layout or font sizes to make one release fit; a layout change is a
   code change for every card, and only reaches users from the next version.

## Scenes

Every text a user reads is a `Localized` (`{ "en-US": "...", "es-ES": "...", ... }`), except
file names, URLs, selectors and terminal lines, which are the same in every language.

**Mascot poses** (`CardPose`): `rest` (sitting), `think` (thinking, a clip), `search` (magnifying
glass, reading code), `code` (typing on a laptop, editing), `celebrate` (clip, happy),
`sad`, `shy` (covers its eyes), `wave` (clip, plays once), `surprised` (clip), `sleep` (clip),
`intro` (takes out its laptop, types once and settles; ~6 s, use it alone).

**Icons** (`CardIcon`): sparkles, terminal, panel, bot, mic, palette, folder, search, refresh,
message, gauge, layers, image, file, pointer, globe, git, bell, keyboard, shield, zap, wrench.

### `mascot`: the mascot on a message box

The mascot sits on a small message box and goes through `steps`, ~1.8 s each, with an
optional status line top-left (one line of ~130 px: "Thinking…", "Reading App.tsx").
`placeholder` replaces the box's "Type / for commands". For what the agent or the mascot does.

```js
scene: { kind: "mascot", steps: [
  { pose: "think", label: { "en-US": "Thinking…", "es-ES": "Pensando…", /* … */ } },
  { pose: "code", label: { "en-US": "Editing main.ts", "es-ES": "Editando main.ts", /* … */ } },
] }
```

### `reactions`: phrases typed, each answered by a pose

Each phrase is typed in the box (≤ 24 characters, written like a user would: lower case,
casual), then the mascot reacts with its pose. Up to 3. For anything that responds to what
the user writes.

```js
scene: { kind: "reactions", steps: [
  { pose: "celebrate", text: { "en-US": "thanks!", "es-ES": "¡gracias!", /* … */ } },
] }
```

### `reply`: a reply to a quoted selection

A quote (one line, ≤ 36 characters) over a box with, optionally, the microphone's sound wave
(`voice: true`) and up to 2 attachment chips that pop in (`{ icon, label }`, label ≤ 16, same in
every language, like a file name). For anything about writing or replying.

```js
scene: { kind: "reply", quote: { "en-US": "The changes panel is slow", /* … */ }, voice: true,
  attach: [{ icon: "image", label: "screenshot.png" }] }
```

### `browser`: a page with one element picked

A small browser window: `url` (≤ 28), one element as a button (`element`, ≤ 18, localized)
outlined as picked, with its `selector` (≤ 20) above it, and a chip that flies to the reply.
For anything in the built-in browser or the preview.

### `terminal`: a few lines of a terminal

Up to 4 lines (≤ 32 characters each, one line each), shown one after another. `kind`:
`cmd` (`$`), `ok` (green ✓), `add` (accent `+`), `out` (plain output). Same in every
language, so keep them as commands and short English output. For shell, CLI, git or build
novelties.

```js
scene: { kind: "terminal", lines: [
  { kind: "cmd", text: "git push" }, { kind: "ok", text: "pushed to origin/main" },
] }
```

### `list`: tagged lines

Up to 2 items, each with a tag (`new`, `improved`, `fixed`, translated by the app) above a
text of at most two lines (≤ 64 characters). The "And also" slide.

### `icon`: one icon

A tinted tile with one icon. The fallback; also what an older app shows for a scene kind it
doesn't know.

## When no scene fits

Use the closest one now. A new scene kind is a code change (`CardScene.tsx`, `sanitizeCard`,
`scenePhases`, `cardTexts`, the audit's `data-fit`/`data-box` marks, a sample slide, this
skill), and versions installed before it show its slides with the `icon` fallback. So the
first release that uses a new kind should be at least one release after the one that adds it.
