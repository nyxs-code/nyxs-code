// Messages the app sends to the agent for its own buttons. The second string is what the chat
// shows instead of the long instruction.

export const ADD_DEV_SERVER_PROMPT = [
  "Añade un servidor de desarrollo a `.claude/launch.json` en la raíz del proyecto (créalo si no existe) con el formato de Claude Code: `{ \"version\": \"0.0.1\", \"configurations\": [{ \"name\", \"runtimeExecutable\", \"runtimeArgs\", \"port\", \"cwd\" opcional }] }`. Mira el package.json / la estructura del proyecto para elegir el comando y el puerto correctos, conserva las entradas que ya haya y dime cuál añadiste.",
  "Añadir servidor a .claude/launch.json",
] as const;

export const START_DEV_SERVER_PROMPT = [
  "Levanta un servidor de desarrollo para este proyecto en SEGUNDO PLANO (run_in_background): usa el script dev/start del package.json si existe, o si es HTML estático sírvelo con un servidor local (p. ej. `npx serve`). Dime en qué puerto/URL queda corriendo. Hazlo directamente, no me preguntes.",
  "Levantar servidor de desarrollo",
] as const;

const APPLY_PLAN_INSTRUCTION =
  "Apply the approved plan to the letter: create or edit the necessary files following EXACTLY the design direction and the decisions described in the plan. Do not use a generic design or change the plan's aesthetic.";

/** "Apply plan", with the plan the chat holds (from WritePlan or an agent CLI's own plan mode):
 *  no plan file is kept in the project for the model to read. */
export function applyPlanPrompt(plan: string | null | undefined): readonly [string, string] {
  const body = plan?.trim();
  return [
    body
      ? `${APPLY_PLAN_INSTRUCTION}\n\n<plan>\n${body}\n</plan>`
      : `${APPLY_PLAN_INSTRUCTION} The plan is the one you presented in plan mode earlier in this conversation.`,
    "Apply plan",
  ] as const;
}
