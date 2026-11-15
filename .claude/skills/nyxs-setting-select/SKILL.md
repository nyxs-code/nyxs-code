---
name: nyxs-setting-select
description: How a dropdown (a choice among options) must be built in the Nyxs app (src/). Use whenever adding, changing or reviewing a `<select>`, a dropdown, a picker of options or a settings row with a value to choose, in Settings or anywhere in Nyxs UI code.
---

# Dropdowns in Nyxs: always `SettingSelect`

A choice among options is never the browser's native `<select>`. The native one opens the operating system's list (square, system font, blue highlight), which looks foreign next to the rest of the app. Use the app's own: **`src/components/settings/SettingSelect.tsx`**. It's a compact button with the current value and a chevron, and it opens a menu with rounded corners where the chosen option has a ✓, the same in every theme.

## How to use it

```tsx
import { SettingSelect } from "./SettingSelect";

<SettingSelect<TitleGenerator>
  ariaLabel={g.titleGenTitle}
  value={value}
  options={TITLE_GENERATORS.map((id) => ({ id, label: g.titleGenOptions[id] }))}
  onChange={(id) => update({ titleGeneration: id } as Parameters<typeof update>[0], "user")}
/>
```

- `options`: `{ id, label, description? }[]`. With a `description` on any option the menu gets wider and shows it under the label.
- `ariaLabel`: the row's title, so a screen reader names the button. It is always required.
- An empty choice ("Select…") is an option with `id: ""`, not a placeholder.
- `align="left"` when the button sits at the start of its column (the code theme pickers), so the menu opens under it. The default opens under the right edge, for the usual row with the control on the right.
- A button beside it (a "Test", a ▶ preview) uses the same height: `h-8 px-3 rounded-md text-[13px]`.

## The row around it

Title on the left (`text-sm font-medium text-text-100`), a line under it (`text-[12px] text-text-400`), and the control on the right, as in `TitleGenerationRow.tsx` and `ThemeColorsCard.tsx`.

## Don't

- Don't write `<select>` / `<option>` in app UI. `fieldSelectClass` was removed so nobody builds one again.
- Don't write a new dropdown component. If `SettingSelect` lacks something (grouping, search), add it there, so every menu changes together.

## Still native (to move)

These native `<select>` are outside Settings and still need moving to `SettingSelect`:

- `src/components/PluginsModal.tsx`: a plugin's boolean option.
- `src/components/video/PlayerPane.tsx`, `video/inspector/fields.tsx` and `video/inspector/EffectsEditor.tsx`: the video editor's compact inspector. The inspector is denser than Settings, so check the button's size there.

## Checking a change

- `rg -n "<select" src` should list only the files above, and fewer each time.
- Open the menu in light and dark: rounded corners, ✓ on the current value, closes with Esc and with a click outside.
