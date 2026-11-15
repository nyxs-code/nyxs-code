---
name: nyxs-corner-radius
description: How rounded corners must be in the Nyxs app (src/). Use whenever adding, changing or reviewing a `rounded-*` class, a `border-radius`, or any new chip, button, input, card, popover, menu, toolbar or dialog in Nyxs UI code.
---

# Corner radius in Nyxs

The user doesn't want very rounded corners: they make the app look soft and bubbly. Keep corners
tight, like a desktop tool.

## Named radii in this app

`src/index.css` sets `--radius: 0.5rem` and derives the theme radii from it: `rounded-lg` is
**8px**, `rounded-md` **6px** and `rounded-sm` **4px**, the same as the explicit values below
(until 2026-10-29 `--radius` was 0.75rem and they were 12/10/8px). Plain `rounded` is 4px.
`rounded-xl`, `rounded-2xl` and `rounded-3xl` are not derived: they keep Tailwind's 12/16/24px,
so they stay off-limits. Either the named class or the explicit `rounded-[8px]`/`rounded-[6px]`
is fine; don't change `--radius` without checking every `rounded-lg/md/sm` again.

## The scale

| What | Class | Radius |
| --- | --- | --- |
| Chips, buttons, inputs, menu rows, tags, code blocks | `rounded-[6px]` or `rounded-md` | 6px |
| Cards, popovers, menus, toolbars, bars, dialogs, panels | `rounded-[8px]` or `rounded-lg` | 8px (the maximum) |
| Thumbnails and small images inside a card | `rounded` / `rounded-sm` | 4px / 2px |
| Circles only: status dots, color swatches, avatars, round icon buttons | `rounded-full` | — |

The compact menus from v0.8.16 use `rounded-[5px]`; that's fine too.

## Rules

1. **Never `rounded-xl`, `rounded-2xl` or `rounded-3xl`**, and no `border-radius` above 8px in CSS
   or inline styles. `rounded-lg` (8px) is for containers only: a button, input or menu row with
   it is too round; use `rounded-md` / `rounded-[6px]`.
2. **Inner corners are smaller than outer ones.** A row inside a menu is `rounded-[6px]` when the
   menu is `rounded-[8px]`; an image inside a card is `rounded`.
3. **`rounded-full` is for circles, not for pills.** A button or chip with text stays
   `rounded-[6px]`, even when it is short.
4. Tooltips already have their radius (6px) from the `app-tooltip` class: don't add `rounded-*` to
   them (see the `nyxs-tooltips` skill).
5. The agent's visuals in the chat (```preview blocks) follow the same rule: their `--radius` is
   6px (`src/lib/visualTheme.ts`) and the prompt (`src/lib/prompts/visualPreview.ts`) caps corners
   at 8px.

## Checking a change

- `rg -n "rounded-(xl|2xl|3xl)\b" <changed files>` must find nothing.
- Every `rounded-lg` in a changed file sits on a card, popover, bar or other container, never on
  a button, input or row.
- `rounded-full` only on circles (dots, avatars, toggles and their knobs, round icon buttons,
  spinners) and thin progress bars; a chip or badge with text is `rounded-[6px]`.
