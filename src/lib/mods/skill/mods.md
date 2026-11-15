A mod changes Nyxs itself: a theme with its own colors and an animated scene behind the chat, a `/` command, a card above the chat box, a toast. It is a plugin in Claude Code's mod format, so the same folder also works as a mod in Claude Code's desktop app.

## Where to write it

Write each mod in its own folder, `${NYXS_DEV_MODS_DIR}/<mod-name>/` (lowercase letters, digits and hyphens), with three files written directly:

- `.claude-plugin/plugin.json`: `{ "name": "<mod-name>", "version": "0.1.0", "description": "<one line>" }`
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`, one path, relative to that file
- `hooks/register.tsx` (or `.ts`): the hooks module, `export const register: Register = (on, options) => { ... }`, the type imported from `'claude-code'`. Split long parts (a scene's SVG) into other files of `hooks/` and import them with relative paths.

## What happens when the turn ends

The first time a turn ends with a mod in that folder, Nyxs asks the user once: "Turn on the mods Nyxs writes in this session?". If they turn them on, every mod there loads when the turn ends, and each later edit reloads it when the turn that made it ends. At your next turn a note tells you what the load came to (loaded, reloaded, not loaded and why, or that the user said no). A reload runs `register` and `session.start` again: `$.state` (the session's) and `$.store` (across sessions) stay, and the module's own variables start over.

## A mod in one paragraph

`on(event, matcher?, hook)` adds a hook, and every hook is `($, e, next)`: `$` reaches the app, `e` is the event's input as a plain value, and `next(e)` runs the mods beneath and then the app's own behaviour, resolving to the event's result. A hook that returns without calling `next` answers for itself; `next({ ...e, text })` rewrites what the rest sees. The module runs in a Worker of its own with no DOM and no Node: everything outside it goes through `$`. JSX compiles against the global `h` (never import or declare `h`), and elements come from `const { Box, Text, Button, Svg } = $.ui.resolve(e)`; `e.surface` is `desktop` in Nyxs.

## What Nyxs answers

| Need | How |
| --- | --- |
| a theme, a look | `$.theme.set({ colors, backdrop, overrideColorScheme })` in `session.start`; `$.theme.clear()` only when the user asks |
| an animated scene | `backdrop: { scene: '<name>', glass? }` and a `ui.render` hook on `{ component: 'Backdrop' }` returning `<Svg source={svg} alt="…" />` |
| a `/` command | `await $.command.register({ name, description })` in `session.start`, answered by `on('command.run', { command: name }, ($, e) => ({ text }))`; `e.args` holds what follows the name |
| a card above the chat box | `on('ui.render', { component: 'AbovePrompt' }, …)` returning a tree, or `next(e)` for none |
| a toast, a status line | `$.ui.toast(text)`, `$.ui.status(text)` (undefined clears it) |
| change or read a prompt | `on('prompt.submit', ($, e, next) => next({ ...e, text }))`, or `{ drop: 'why' }` |
| react to a reply | `on('session.append', { door: 'response' }, …)`: `e.message.content` holds its text blocks |
| values a drawing reads | `import { atom, read, update } from 'claude-code'`: `atom({ plugin: '<mod-name>', key: 'k' } as const, initial)`, `read($, a)` while drawing, `update($, a, fn)` from a handler; a write redraws |
| keep a value across sessions | `$.store.get/set/delete/keys` |
| timers | `$.clock.after(ms, fn)` and `$.clock.every(ms, fn)` (each returns `{ cancel }`), `$.clock.sleep(ms)` |
| the session | `$.session.id()`, `cwd()`, `root()`, `repo()`, `model()`; `$.fs.stat/exists/read/list` |

Anything else on `$` is absent in Nyxs: calling it throws a TypeError. Don't write `$.ui.open` panes, `tool.call` hooks or model calls here.

## A look

Send the whole theme in one `$.theme.set` at `session.start`: a later set replaces it.

```tsx
import type { Register, ThemeSetArgs } from 'claude-code'
import { makeColors } from './make-colors.js'
import { SCENE } from './scene'

const { theme, problems } = makeColors({
  label: 'Lagoon',
  roles: { accent: '#1f8a9e', danger: '#c0473a', success: '#3f8a4f', warning: '#b07a12', pro: '#6d5aa8' },
  light: { gray: { anchors: { 'surface-0': '#e3f1f2', 'surface-1': '#ecf6f6', 'surface-2': '#f6fbfb', 'text-primary': '#10292d', 'text-secondary': '#2f4f54', 'text-muted': '#4d6a6e' } } },
  dark: { gray: { anchors: { 'surface-0': '#0d1d21', 'surface-1': '#12262b', 'surface-2': '#173036', 'surface-3': '#1c3940', 'text-primary': '#e2f1f2', 'text-secondary': '#b9d2d4', 'text-muted': '#93b0b3' } } },
})

const LOOK: ThemeSetArgs = { colors: theme, backdrop: { scene: 'lagoon', glass: { blur: 12, opacity: 0.5 } } }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (problems.length) $.ui.log(problems.join('\n'), { to: 'debug' })
    await $.theme.set(LOOK)
    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if (e.props.plugin !== '<mod-name>' || e.surface !== 'desktop') return next(e)
    const { Svg } = $.ui.resolve(e)
    return <Svg source={SCENE} alt="A lagoon seen from above" isInteractive />
  })
}
```

- **colors**: never write the palette by hand (its keys are the design system's, and a wrong one paints nothing). Write the helper below as `hooks/make-colors.js`, unchanged, and call `makeColors`. Anchors, per mode: `surface-0` (the page) and `text-primary` are required, then `surface-1`, `surface-2`, `surface-3`, `text-secondary`, `text-muted`; `surface-0` is the darkest surface in both modes. Roles: `accent`, `danger`, `success`, `warning`, `pro`. `codeTheme: { light, dark }` names a code theme (Nyxs has `dark-plus`, `github-dark`, `monokai`, `dracula`, `nord`, `solarized-dark`, `github-light`, `one-light`, `solarized-light`, `catppuccin-latte`, `gruvbox-light`, `ayu-light`). Work until `problems` is empty or close to it.
- **One mode**: for a look made for dark (or light) only, give that half alone, or set `overrideColorScheme: 'dark'`: the app switches to that mode while the theme stands and back after.
- **The scene**: one SVG string under 131,072 characters, with a `viewBox` and `preserveAspectRatio="xMidYMid slice"` so it fills any window, animated with CSS in its own `<style>`. It runs no script and loads nothing (no external images or fonts). Add `@media (prefers-reduced-motion: reduce) { * { animation: none } }` so it rests in a composed picture. Keep the subject away from the middle, where the messages sit, and from the bottom, where the chat box sits.
- **glass**: `{ blur, tint, opacity }` frosts the title bar and the sidebar over the scene (blur 0–64, opacity 0–1, tint a raw color such as `#e6fbff`), or `false` to leave them solid.
- **A still ground** needs no hook: `backdrop: { color }`, `{ gradient: { stops: ['surface-0', '#1f8a9e'], angle } }`, `{ vector: { viewBox, paths } }` or `{ image: { source: 'bg.jpg' } }` (a JPEG or PNG in the mod's folder, at most 1 MiB).

## What good looks like

- **Tint the grays** from the look's hue and keep neighbouring surfaces a few percent of lightness apart, so a card reads as paper on paper.
- **Words come first**: `text-primary` at 7:1 or better on every surface, `text-muted` at 4.5:1 on `surface-0`.
- **Keep meaning**: `danger` stays a red, `success` a green, `warning` an amber, tuned toward the look.
- **Both modes**, unless the idea can't: dark as a second version of the idea, not an inversion.
- **Your own art**: the spirit of a place or an era, never a company's logo, artwork or font.

Ask the user to look at it in both modes and with a long code block in the chat.

## hooks/make-colors.js

```js
{{MAKE_COLORS}}
```
