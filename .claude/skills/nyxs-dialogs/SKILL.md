---
name: nyxs-dialogs
description: How dialogs, modals and their buttons must be built in the Nyxs app (src/). Use whenever adding or changing a dialog, modal, confirmation, popup panel over the app, or an overlay with `fixed inset-0`, or a plain action button (cancel, confirm, close) in Nyxs UI code.
---

# Dialogs and buttons in Nyxs

Every dialog uses `Dialog` from `src/components/ui/dialog.tsx`, and plain action buttons use
`Button` from `src/components/ui/button.tsx`. Never hand-roll a `fixed inset-0` backdrop + panel:
each copy got Escape, focus, screen readers and the browser panel slightly wrong.

## What `Dialog` already does

- Backdrop below the 36px title bar (the window can still be moved), dimmed, click outside closes.
- Escape closes the innermost dialog only (it stops the event), and the app's own Escape
  (stop the reply) ignores open dialogs.
- Focus moves into the dialog on open (the first control, or `initialFocus`), Tab stays inside,
  and focus returns where it was on close.
- `role="dialog"` (or `"alertdialog"` for a confirmation), `aria-modal`, named by `DialogTitle`
  or the `label` prop, `describedBy` for the explaining text.
- Works over a website open in the browser panel: `data-webview-backdrop`/`data-webview-hole`
  and `useShownOverNativeViews` (on Windows the page cuts a hole and keeps playing; elsewhere
  it steps aside before the dialog shows).
- 8px corners, border, `bg-bg-100`.

## Using it

```tsx
<Dialog open={open} onClose={onClose} className="max-w-lg">
  <DialogHeader>
    <SomeIcon className="w-4 h-4 text-accent" />
    <DialogTitle>{t.title}</DialogTitle>
  </DialogHeader>
  <div className="px-4 …">…</div>
  <DialogFooter>
    <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
    <Button variant="primary" onClick={onSave}>{t.save}</Button>
  </DialogFooter>
</Dialog>
```

- Width, height and inner layout go in `className` on `Dialog` (`max-w-2xl max-h-[80vh]`).
- `stacked` for a dialog opened over another dialog or over Settings (z-60 instead of z-50).
- `dismissible={false}` only for a choice the user must make.
- Need Escape to close something inside first (a menu, a search)? Handle it in an `onKeyDown`
  on an inner wrapper and call `e.stopPropagation()` only in that case (`RewindDialog`).
- Don't add window `keydown` listeners for Escape, `stopPropagation` on the panel's click, or
  focus code: the dialog covers them.
- `DialogHeader` shows a close X with the `modals.close` label; `close={false}` hides it when
  the footer already has the way out.

## Buttons

`Button` variants: `primary` (accent), `secondary` (bordered, the default), `ghost`, `danger`;
`icon` for a square icon-only button (give it `aria-label`). 6px corners, 28px high, focus
ring. List rows, tabs, toggles and menu items stay their own elements, but follow the corner
scale of the `nyxs-corner-radius` skill.

## Tests

`src/components/ui/__tests__/dialog.test.tsx` (jsdom + Testing Library). A change to `Dialog`'s
behaviour gets a case there. Component tests are `*.test.tsx` and start with
`// @vitest-environment jsdom`; the rest of the suite stays on the node environment. In jsdom the
dialog shows after a microtask (`await act(async () => {})`).

## Not dialogs

Menus, drag shields (`data-drag-shield`), click-catchers behind a menu, the error screen and the
image lightbox are not dialogs; don't wrap them in `Dialog`.
