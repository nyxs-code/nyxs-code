---
name: nyxs-chat-code-blocks
description: How fenced code blocks and copyable drafts (emails, messages) must look in the Nyxs chat (src/). Use whenever adding, changing or reviewing `CodeBlock` in src/components/message/markdown.tsx, how a fenced block renders in an assistant message, a copy button on chat content, or the system-prompt rules that decide how the agent fences code and drafts.
---

# Code blocks in the Nyxs chat

A fenced block in an assistant message looks like Claude Code's: **no box**. No border, no background, no header with the language name and no "Copiar" label. Just the content, indented, with a copy icon at its top right.

The component is `CodeBlock` in `src/components/message/markdown.tsx`. `Message.tsx` (`renderSegment`) sends every fenced block there, except `preview`, `nyxs-review` and shell languages (`RunnableCommand`), which have their own components.

## The rules

1. **Unboxed.** The wrapper is `relative my-4 w-fit max-w-full pl-4 pr-10`. Don't add `border`, `rounded-*`, `bg-*` or a header bar back.
2. **The block is as wide as its content (`w-fit`).** That way the copy icon sits just after the longest line, not against the right edge of the chat. A short snippet gets its icon next to the code; a long one fills the width and wraps.
3. **Copy icon only.** Use lucide `Copy`, which turns into `Check` for 1.5 s after copying. Size `w-4 h-4`, `absolute top-0 right-1 p-1 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200`. It is icon-only, so it gets `aria-label` and `data-tooltip` (see the `nyxs-tooltips` skill). No visible text.
4. **Never scroll, wrap.** No horizontal scrollbar and no `max-h-*`/`overflow-auto` inside the block. Code uses `whitespace-pre-wrap [overflow-wrap:anywhere]`, the same as the edit diffs in the chat (`DiffView.tsx`), so long lines wrap and indentation is kept. The whole block is shown; the chat itself scrolls.
5. **Three kinds of content, one look.** All three share the wrapper and copy icon:
   - **Code** (any language in `CODE_LANGS`, or unknown): `<pre>` at `text-[13px] leading-relaxed`, monospace, highlighted with `Highlighted`. Colours come from the code palette (`--code-*` variables, `applyCodePalette` in `src/lib/appearance.ts`), which follows the light/dark theme. Don't hard-code token colours.
   - **Prose drafts** (`PROSE_LANGS`: `text`, `txt`, `plain`, `plaintext`, `email`, `mail`, `message`): a `<p>` with the chat's own text style (`text-[15px] leading-[1.75]`, sans), `whitespace-pre-wrap`. An email reads like an email, not like code.
   - **Markdown** (`markdown`/`md`, or an unknown tag whose content looks like Markdown): rendered with `MarkdownText`. This is how reusable prompts are delivered.
6. **Copy copies the raw content.** For a draft that means the whole draft, subject line included, without the fences.

## Tool output (an expanded command row)

A command's output under its tool row follows the same idea (`ToolOutput` in `src/components/message/ToolChips.tsx`): no box, no "Output" header, no code background. The text sits on the thin left rail the reasoning and error text use (`ml-[7px] pl-3 border-l border-bg-300`), with the same copy icon right after its longest line, and long lines wrap. The one difference with chat code blocks: tool output keeps a `max-h-72` scrolling window, because a command can print thousands of lines. "Output truncated" goes on a small italic line under it.

## What the agent must write

The look depends on the agent fencing things correctly. The rules live in `src/lib/systemPrompt.ts` (the "Tone and style" list):

- Code always goes in a fenced block with its language tag.
- A reusable prompt goes in one ` ```markdown ` block.
- A draft the user will send somewhere else (email, message, post, reply) goes in one ` ```text ` block, subject line included. Comments about it go outside the block.

If you add a new kind of copyable output, add its tag to the right set (`CODE_LANGS` or `PROSE_LANGS`) and add a matching line to the system prompt.

## Checking a change

- Render a short snippet, a snippet with a line longer than the chat, and a ` ```text ` email. The short snippet's icon sits next to its code. The long line wraps with no horizontal scrollbar. The email shows in the chat font.
- Check both themes: code colours change with the theme, and the icon stays `text-text-400`.
- `npx tsc -b` and `npx eslint src/components/message/markdown.tsx`.
