import { GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } from "../toolNames";

export function getAgentDescription(listing: string, models: string[] = []): string {
  const modelNote = models.length
    ? `\n- You may set \`model\` to run the agent on a specific model (one of: ${models.join(", ")}). Omit it to inherit the current model. Use a faster/cheaper model for broad exploration when appropriate.`
    : "";
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches a specialized sub-agent that handles a task on its own and reports back. Each agent type has specific capabilities and tools available to it. Crucially, the sub-agent's intermediate work (file reads, searches, command output) stays in ITS context, not yours — you only get its final report. Use this to investigate or fan out work WITHOUT filling your own context.

Available agent types and the tools they have access to:
${listing}

When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

When NOT to use the Agent tool:
- If you want to read a specific known file path, use ${READ_TOOL_NAME} or ${GLOB_TOOL_NAME} instead — it's faster.
- If you are searching for a specific definition like "class Foo", use ${GREP_TOOL_NAME}/${GLOB_TOOL_NAME} directly.
- If the task only involves 2-3 specific files you already know, just use ${READ_TOOL_NAME}.

Usage notes:
- Always include a short description (3-5 words) of what the agent will do.
- If the user asks you to run agents "in parallel", or you have multiple independent investigations, issue them in a SINGLE response with multiple Agent tool calls — they run concurrently.
- When the agent finishes it returns a single message. That result is NOT shown to the user; relay a concise summary yourself.
- The agent is stateless and has NO access to this conversation. Provide a complete, self-contained task description each time. It cannot ask you follow-up questions.
- Clearly tell the agent whether you expect it to write code or just to research (search, file reads), since it is not aware of the user's intent.${modelNote}

Forking (advanced):
- Set \`fork: true\` to fork yourself instead of spawning a fresh agent: the fork INHERITS your full conversation context and gets the complete toolset. \`subagent_type\` is ignored when forking.
- Fork when the work needs context you'd otherwise have to re-explain (an implementation task building on this conversation), but whose intermediate tool output you don't want in your own context. The prompt is then a directive ("do X"), not a briefing.
- Spawn a fresh agent (omit \`fork\`) for independent investigation that doesn't need this conversation's history.

Writing the prompt:
- For a fresh agent, brief it like a smart colleague who just walked in: it hasn't seen this conversation. Explain what you're trying to accomplish and why, and what you've already learned or ruled out.
- Tell it exactly what to report back (file paths, \`path/file:line\`, a short answer). If you need a short response, say so.
- Don't delegate understanding: don't write "based on your findings, fix the bug". Include the specifics that prove you understood the problem.`;
}
