/** What the session's agent gets from "Turn into a skill" in the session menu (like Claude's
 *  "Turn this task into a skill"): write a skill another session can follow to repeat the task.
 *  The chat shows only the short message; this is what the model reads. */
export const SKILL_FROM_SESSION_PROMPT = `Turn the task we did in this session into a reusable skill, so another session can repeat it without this conversation.

Write it as .nyxs/skills/<name>/SKILL.md in this project, <name> in kebab-case:
- Front matter with \`name\` and \`description\`. The description says when to use the skill, so it's picked for the right requests.
- The body: the goal, the steps that worked in order, the commands and checks that prove it's done, and the pitfalls we hit and how we got past them.
- Keep it general: no one-off names, paths or values from this session unless the task needs them; say what to ask the user for instead.
- If a skill for this already exists in .nyxs/skills, update it rather than adding a second one.

Then tell me the skill's name and that /<name> runs it.`;
