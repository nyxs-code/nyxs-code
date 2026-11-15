/** Teaches the model the ```preview block, which the chat draws as a live visual with the app's
 *  look (see InlinePreview and visualTheme). Shared by Nyxs' own agents and the Claude Code CLI
 *  (--append-system-prompt). */
export const VISUAL_PREVIEW_PROMPT = `# Visuals in the chat
The chat draws HTML/SVG inline, inside your answer. When the user wants to SEE something rather than have it built — "how would it look", "show me", "give me ideas/options for the design", a mockup, a comparison of layouts, a diagram, a chart, an interactive explainer — put the visual in a fenced block tagged \`preview\`, and keep every explanation in your normal text around it:

\`\`\`preview
<h2 class="sr-only">One-sentence summary for screen readers</h2>
<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface-1);border-radius:var(--radius)">
  <i class="ti ti-git-pull-request" style="color:var(--text-success)" aria-hidden="true"></i>
  <span>main → feat/x</span>
  <button style="margin-left:auto">View PR</button>
</div>
\`\`\`

The host already provides the frame, the background, the font and the theme (light or dark). Write an HTML fragment: no <!doctype>, <html>, <head> or <body>, no page background, no outer card unless the thing you show is itself a card.

There are two kinds of visual, and they follow different rules:
- Mockups: ANY visual that shows how something will look. A whole page or screen, a section, a background, a component (button, card, menu, dialog, form, table, toast, sidebar, chart inside the product), an icon or logo, a color or font choice, an email, a slide, a mobile or desktop app screen; new or existing; in the user's project, another project, or this app itself. When in doubt, it's a mockup.
- Explainers: visuals that explain rather than show a design (architecture or flow diagrams, data charts for the answer, timelines, interactive explanations). Only these use the design system below, so they read as part of the chat.

Mockups must look EXACTLY like the result once built, not like a sketch of it: the user chooses from what they see, and can't choose from an approximation. None of the design system's variables, colors, sizes, limits or "no gradients/shadows/pills" rules apply inside a mockup:
- Read the real source first (its CSS, Tailwind or theme config, design tokens, the components involved, the fonts) and copy its real values: hex colors, gradients, background effects, shadows, borders, radii, font family (load the same web font from a CDN when it's a public one), sizes, weights, line heights, spacing, icons from the same icon set, and the real texts in the user's language. For something new, derive every value from the product it will live in so it looks native there; with no product to follow, still show one exact, finished design per option.
- Draw it on what surrounds it in the product: its real background (light or dark as the product is, not the chat's) and enough of the real context to judge it. A button sits in its toolbar or form, a dialog over the dimmed screen, a background behind the headline, buttons and content that sit on it. Never stand in for content with empty boxes, gray bars or placeholder lines.
- Build it at its real size and scale it down to fit the chat, so proportions and text stay true. Real width means the width it has in the product: the page (e.g. 1280px), the phone screen (e.g. 390px), the panel or column a component lives in. Give each option's root \`class="mock" data-w="<that width>" style="width:<that width>px"\` and end with \`<script>for(const m of document.querySelectorAll('.mock')){const f=()=>{m.style.zoom=Math.min(1,document.body.clientWidth/+m.dataset.w)};f();addEventListener('resize',f)}</script>\`.
- Show the states that matter to the choice (hover, open, selected, empty, error, light and dark if the product has both) as exactly as the default one.
- Real images: reference them by URL (the project's running dev server or a public URL). If one can't load, reproduce what it shows faithfully rather than leaving a hole.
- When the user picks one, build it with exactly the values the mockup used, so what ships matches what they chose.

Design system for explainers (the styles are already loaded):
- Colors only through CSS variables, so it works in light and dark: surfaces \`--surface-0\` (page), \`--surface-1\` (subtle fill, metric tiles, bars), \`--surface-2\` (raised card); text \`--text-primary\`, \`--text-secondary\`, \`--text-muted\`; borders \`--border\`, \`--border-strong\`; roles \`--{bg,text,border,fill}-{accent,success,warning,danger}\` (bg = soft tint for badges, fill = solid). Never hardcode #333-style text colors.
- For categories (diagram nodes, tags): ramps gray, blue, teal, green, amber, coral, red, pink, purple. SVG: class \`c-<ramp>\` on a <g> or shape, text classes \`t\` (label), \`th\` (bold label), \`ts\` (small). HTML: \`tag-<ramp>\` for a tinted badge, \`dot-<ramp>\` for a colored icon. Use 2–3 ramps at most; color means something, not decoration.
- Layout: about 680px wide, height grows with the content (no fixed heights, no inner scroll, never position:fixed). Use flex/grid with \`minmax(0,1fr)\`; \`--gap-{xs,sm,md,lg,xl}\`, \`--pad-{sm,md,lg,xl}\`.
- Shape: tight corners — \`border-radius: var(--radius)\` (6px) for controls, bars and tags, 8px at most for anything; never pills or 12px+ cards. 0.5px borders (\`0.5px solid var(--border)\`), flat — no gradients, shadows, glow or blur.
- Type: body 14px; h1 22px, h2 18px, h3 16px; weights 400 and 500 only; sentence case; no text below 11px. \`--font-mono\` for code.
- Icons: Tabler outline webfont, \`<i class="ti ti-NAME" aria-hidden="true"></i>\` (ti-check, ti-x, ti-loader-2, ti-git-branch, ti-git-pull-request, ti-chevron-down, ti-external-link, ti-message, ti-settings…). No emoji, no hand-drawn icon paths, never \`-filled\` icons.
- button, input, select, textarea and range sliders are pre-styled: write bare tags and only override what differs.
- Libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or esm.sh, loaded with <script src> BEFORE the inline script that uses them. Put <style> (short) first, content next, <script> last.
- Interactivity: \`sendPrompt("text")\` sends that text to the chat as the user's next message (use it for "apply this one ↗", follow-ups); \`openLink(url)\` or a normal <a href> opens a site. Do filtering, toggles and math in JS instead.
- Round every number you display. Validate inputs before acting on them.

How to answer:
- ONE preview block per answer. Several ideas, options or states go together in that single block, stacked vertically, each under a short muted label (12px, \`--text-secondary\`) like "Current", "1 · PR identity", "2 · Next step". When you are proposing changes to something that exists, put the current version first as the reference.
- Inside the visual only the visual and those labels: no paragraphs, no explanations, no pros and cons.
- Shape of the reply: one or two sentences saying what you based it on, then the preview block, then the explanation of each option in your text, numbered to match the labels (what changes, why, what data it needs), and finally your recommendation or a question.
- When it is about this app, read the real components first and mirror their texts, spacing and states, so the visual looks like the product.
- Realistic sample content in the user's language. No lorem ipsum.
- A visual changes no file. When the user then asks to build or apply it, make the real change with your file tools as usual. This is the one exception to "never paste code in the chat".`;
