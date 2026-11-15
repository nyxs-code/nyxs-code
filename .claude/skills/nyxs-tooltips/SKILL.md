---
name: nyxs-tooltips
description: How tooltips must look and be built in the Nyxs app (src/). Use whenever adding, changing or reviewing a tooltip, a hover hint, a `title=` attribute or a `data-tooltip` attribute in Nyxs UI code.
---

# Tooltips in Nyxs

Every tooltip in the app looks the same: **dark in the light theme** (near-black `#1a1a19`, white text, like Claude's), and the theme's own surface in the dark theme. Never a light/white tooltip in light mode, and never the browser's native tooltip.

## The rule

1. **Plain text tooltip → `data-tooltip`.** Put `data-tooltip={text}` on the element. `src/components/TooltipLayer.tsx` (mounted once for the whole app) shows it centred above the element (below it near the top edge), already styled.
   - **Keyboard shortcut:** add `data-tooltip-kbd="Ctrl+\`"` next to `data-tooltip`. The layer shows the label in bold and the shortcut after it in the muted colour ("**Terminal** Ctrl+\`"), like Claude's tooltips. Also set `aria-keyshortcuts` to the same value. Write shortcuts as `Ctrl+Shift+B` (words, `+`, no spaces), and keep them in sync with the handler in `App.tsx` and the list in `ShortcutsModal.tsx`.
2. **Never use `title=` for a tooltip.** WebView2 draws native `title` tooltips light and unstyled. Use `data-tooltip` instead. For an icon-only button, also give it `aria-label={text}` so it keeps an accessible name (that is what `title` used to provide).
   - `title=` is still fine where it is not a tooltip: an `<iframe title>`, or a component's own `title` prop (`<SettingRow title=…>`, `<ConfirmDialog title=…>`).
3. **Rich tooltip (two lines, bold figure, etc.) → the `app-tooltip` class.** When a tooltip needs more than one string (for example the context ring: "Ventana de contexto: 15%" with "29.9k / 200k" under it), build it by hand but style it only with the shared classes from `src/index.css`:
   - `app-tooltip` on the bubble: background, text colour and border for both themes.
   - `app-tooltip-muted` on secondary lines (the grey second line).
   - Do not hard-code colours (`bg-[#1a1a19]`, `text-white`, `bg-bg-100`…) on a tooltip; the class switches them with the theme.
4. **Centred on its anchor.** Position the bubble with `absolute bottom-full left-1/2 -translate-x-1/2 mb-2` (the `data-tooltip` layer already does this), `shadow-xl` (the corner radius, 6px, comes from `app-tooltip` itself — don't add a `rounded-*` class), `px-2.5 py-1.5`, `whitespace-nowrap` for short text, and `pointer-events-none`.
5. **Over the browser panel → `data-webview-hole`.** The browser's native webview draws on top of the whole app, so a tooltip reaching over the page shows behind it. The `data-tooltip` layer already marks its bubble; a hand-built tooltip that can reach the page must also carry `data-webview-hole` (the page cuts a hole for it, `src/components/views/preview/webviewHoles.ts`), and must only be in the DOM while shown (`{hover && …}`), not hidden with `group-hover:block`, which the page can't detect.
6. **Hide it while its own menu or panel is open** (e.g. `{!open && <span className="app-tooltip …">…</span>}`), so it never covers what the click opened.

## Example

```tsx
<button type="button" aria-label={t.contextWindow} className="group relative …">
  {/* icon */}
  {!open && (
    <span className="app-tooltip pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block whitespace-nowrap px-2.5 py-1.5 text-left shadow-xl z-50">
      <span className="block text-[12px] font-semibold">{t.contextWindow}: {pct}%</span>
      <span className="block text-[11px] app-tooltip-muted">{used} / {total}</span>
    </span>
  )}
</button>
```

## Checking a change

- `rg -n "\stitle=[{\"]" src --glob "*.tsx"`: every hit must be an iframe or a component prop, not a DOM tooltip.
- Hover the tooltip in the light theme: dark bubble, white text, centred over the element.
