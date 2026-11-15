import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getAskUserQuestionDescription } from "@/tools/AskUserQuestion/prompt";
import type { AskQuestion } from "@/tools/AskUserQuestion/types";
import type { ToolContext } from "@/tools/context";

export function addAskUserQuestionTools(tools: ToolSet, ctx: ToolContext): void {
  const { askUser } = ctx;
  if (!askUser) return;
  tools.AskUserQuestion = tool({
    description: getAskUserQuestionDescription(),
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe("The full question text. Clear and specific; end with a question mark."),
            header: z.string().describe("Very short chip label for the question (e.g. \"Library\", \"Approach\")."),
            options: z
              .array(
                z.object({
                  label: z.string().describe("Short option text the user selects (1-5 words)."),
                  description: z.string().optional().describe("What this option means or implies (trade-offs)."),
                }),
              )
              .min(2)
              .max(4)
              .describe("2-4 distinct, mutually-exclusive choices (unless multiSelect)."),
            multiSelect: z.boolean().optional().describe("Allow selecting multiple options (default false)."),
          }),
        )
        .min(1)
        .max(4)
        .describe("1-4 questions to ask the user."),
    }),
    execute: async ({ questions }) => {
      const answers = await askUser(questions as AskQuestion[]);
      if (!answers) {
        return "The user dismissed the questions without answering. Do not assume an answer — ask them how they'd like to proceed, or continue with a clearly-stated default.";
      }
      const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
      return `The user answered your question(s):\n\n${text}\n\nContinue with these answers in mind.`;
    },
  });
}
