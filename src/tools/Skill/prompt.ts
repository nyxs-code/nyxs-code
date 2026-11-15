export function getSkillDescription(): string {
  return `Execute a skill within the conversation.

When the user asks for a task, check whether any available skill matches. Skills provide specialized capabilities and domain knowledge.

When the user mentions a "slash command" or "/<something>" (e.g. "/commit"), they are referring to a skill: invoke it with this tool.

How to invoke:
- Use this tool with the skill name and optional arguments.
- Examples: { skill: "commit" }, { skill: "review-pr", args: "123" }.

Important:
- Available skills are listed in the system prompt ("Available skills").
- When a skill matches the request, invoke it BEFORE generating any other response about the task — before reading files, planning, or writing code.
- NEVER mention a skill without actually invoking it with this tool.
- Do not invoke a skill that is already running.`;
}
