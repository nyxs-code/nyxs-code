import { REQUEST_PERMISSION_TOOL_NAME, WRITE_PLAN_TOOL_NAME } from "../toolNames";

export function getAskUserQuestionDescription(): string {
  return `Ask the user multiple-choice questions to gather information, clarify ambiguity, understand preferences, or make a decision when there's a fork in the road.

When to use:
- You hit a decision that's genuinely the user's to make and you can't resolve it from the request, the code, or sensible defaults (e.g. which library, which approach, which scope).
- Prefer asking ONE focused question with 2-4 clear options over guessing wrong and redoing work.

Usage notes:
- Each question needs a short \`header\` (a chip label, e.g. "Library", "Approach"), the full \`question\` text, and 2-4 \`options\` (each a short \`label\` plus a \`description\` of what it means / its trade-offs).
- If you recommend an option, put it first and add "(Recommended)" to its label.
- Set \`multiSelect: true\` whenever the options are NOT mutually exclusive and the user could reasonably want several at once (e.g. "which sections need an image?", "which features to enable?", "which file types to include?"). Default to single-select only when exactly one answer makes sense.
- The user can always pick "Other" and type their own answer, so don't add an "Other" option yourself.
- Don't use this for permission to act (use ${REQUEST_PERMISSION_TOOL_NAME}) or for trivial choices with an obvious default — just proceed in those cases.

Plan mode note: in plan mode, use this to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT ask "Is my plan ready?" or "Should I proceed?", and do NOT reference "the plan" in your questions — the user cannot see it until you call ${WRITE_PLAN_TOOL_NAME}.`;
}
