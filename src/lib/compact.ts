const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

export const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Respond with TEXT ONLY. Do NOT call any tools — you already have all the context you need above. Your entire response must be an <analysis> block followed by a <summary> block.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests. If your last task was concluded, only list next steps if they are explicitly in line with the user's request.

If the conversation starts with a summary of an earlier portion, fold it into this summary: keep its facts, decisions, file paths and pending tasks that still apply, and drop what is obsolete. Keep exact file paths, symbol names, commands, error messages and IDs verbatim, and record the git state (branch, uncommitted or pushed work) when it matters. Do not mention that the conversation was summarized, and leave out project instructions and environment details, which are provided again separately.

Structure your output like this:

<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]
</summary>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.${NO_TOOLS_TRAILER}`;

/** For a single turn that no longer fits: summarizes the steps taken since the user's latest
 *  request, which stays above it verbatim, as do the most recent steps after the summary. */
export const TURN_PREFIX_COMPACT_PROMPT = `Your task is to create a detailed summary of the work you have done in the CURRENT turn so far: every step since the user's latest request. That request and everything before it stay in the conversation as they are, and your most recent steps will follow your summary verbatim, so summarize only the steps in between. This summary should be thorough in capturing technical details, code patterns, and decisions that would be essential for continuing the task without losing context.

Respond with TEXT ONLY. Do NOT call any tools — you already have all the context you need above. Your entire response must be an <analysis> block followed by a <summary> block.

Before providing your final summary, wrap your analysis in <analysis> tags. In it, go through your steps of this turn in order and identify the tools you called and what they returned, the files you read, created or changed (with the exact edits), the commands you ran and their results, and the errors you hit and how you dealt with them.

Your summary should include the following sections:

1. Task: The user's latest request in one or two sentences, as you understood it.
2. Steps Taken: What you did, in order, with the tool calls that mattered and what they showed.
3. Files and Code Sections: Files read, created or changed, with the important snippets and edits verbatim.
4. Errors and fixes: Errors you ran into and how you fixed them, or that they are still open.
5. Findings: Facts you established that the rest of the task depends on.
6. Current State: Where the work stands at the end of these steps: what is done and what is left.
7. Next Step: What you were about to do next.

If a summary of earlier steps of this turn already appears among them, fold it into this one: keep its facts, edits and open items that still apply. Keep exact file paths, symbol names, commands, error messages and IDs verbatim. Do not mention that the steps were summarized.

Structure your output like this:

<analysis>
[Your thought process]
</analysis>

<summary>
1. Task:
   [Description]

2. Steps Taken:
   - [Step 1]

3. Files and Code Sections:
   - [File Name 1]
      - [What changed or what it showed]

4. Errors and fixes:
   - [Error]: [Fix]

5. Findings:
   - [Finding 1]

6. Current State:
   [Description]

7. Next Step:
   [Next step]
</summary>${NO_TOOLS_TRAILER}`;

/** What replaces the summarized first steps of the current turn. */
export function getTurnPrefixMessage(summary: string): string {
  return `The earlier steps of this turn ran out of context, so they were summarized. The summary below covers your work since the user's request above; your most recent steps follow it verbatim.

${formatCompactSummary(summary)}

Continue the task from where those steps left off, without repeating work the summary says is done.`;
}

export function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, "");

  const match = out.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(match[1] || "").trim()}`);
  }

  return out.replace(/\n\n+/g, "\n\n").trim();
}

const CONTINUATION_LEAD = "This session is being continued from a previous conversation that ran out of context.";

/** Whether `m` is the summary of earlier turns that a compaction put at the head of the chat. */
export function isContinuationMessage(m: { role: string; content: unknown }): boolean {
  return m.role === "user" && typeof m.content === "string" && m.content.startsWith(CONTINUATION_LEAD);
}

export function getContinuationMessage(
  summary: string,
  opts: { recentPreserved?: boolean; suppressFollowUps?: boolean } = {},
): string {
  const { recentPreserved = true, suppressFollowUps = false } = opts;
  let msg = `${CONTINUATION_LEAD} The summary below covers the earlier portion of the conversation.

${formatCompactSummary(summary)}`;

  if (recentPreserved) {
    msg += `\n\nRecent messages are preserved verbatim below.`;
  }
  if (suppressFollowUps) {
    msg += `\n\nContinue from where it left off without asking further questions. Resume directly — do not acknowledge the summary or recap what was happening. Pick up the last task as if the break never happened.`;
  }
  return msg;
}
