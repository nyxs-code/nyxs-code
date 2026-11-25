export interface SlashCommand {
  name: string;
  description: string;
  kind?: "builtin" | "skill";
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Ver los comandos disponibles", kind: "builtin" },
  { name: "shortcuts", description: "Ver los atajos de teclado", kind: "builtin" },
  { name: "clear", description: "Borrar la conversación actual", kind: "builtin" },
  { name: "new", description: "Empezar un chat nuevo", kind: "builtin" },
  { name: "compact", description: "Resumir la conversación para liberar contexto", kind: "builtin" },
  { name: "retry", description: "Reenviar tu último mensaje", kind: "builtin" },
  { name: "copy", description: "Copiar la última respuesta del agente", kind: "builtin" },
  { name: "plan", description: "Alternar el modo planificación", kind: "builtin" },
  { name: "verify-plan", description: "Verificar que lo implementado coincide con el plan aprobado", kind: "builtin" },
  { name: "model", description: "Gestionar modelos y API keys", kind: "builtin" },
  { name: "settings", description: "Abrir Configuración", kind: "builtin" },
  { name: "doctor", description: "Diagnóstico del entorno: claves, MCP, permisos, versión", kind: "builtin" },
  { name: "status", description: "Estado de la sesión: modelo, carpeta, contexto", kind: "builtin" },
  { name: "mcp", description: "Listar servidores MCP configurados", kind: "builtin" },
  { name: "skills", description: "Listar skills disponibles", kind: "builtin" },
  { name: "plugins", description: "Gestionar plugins y marketplaces", kind: "builtin" },
  { name: "diff", description: "Ver los cambios de git en un panel de revisión", kind: "builtin" },
  { name: "terminal", description: "Abrir la vista de Terminal", kind: "builtin" },
  { name: "files", description: "Abrir la vista de Archivos", kind: "builtin" },
  { name: "tasks", description: "Abrir Tareas en segundo plano", kind: "builtin" },
  { name: "preview", description: "Abrir la vista previa", kind: "builtin" },
  { name: "resume", description: "Continuar una sesión de Claude Code de la terminal o la app", kind: "builtin" },
  { name: "btw", description: "Pregunta rápida en un chat lateral sin guardar (Ctrl+J)", kind: "builtin" },
  { name: "goal", description: "Fija un objetivo: el agente sigue trabajando hasta cumplirlo", kind: "builtin" },
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name));

export function parseBuiltinCommand(message: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_:-]+)\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!BUILTIN_NAMES.has(name)) return null;
  return { name, args: m[2].trim() };
}

export interface PromptCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
}

export const BUILTIN_PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "commit",
    description: "Crear un commit de git con los cambios actuales",
    body: `Create a git commit for the current changes.
1. Run GitStatus and GitDiff to review exactly what changed (both staged and unstaged).
2. Stage the relevant files with \`git add\` via the Bash tool.
3. Write a clear, conventional commit message (a concise subject line, plus a body when the change is non-trivial) and create the commit with the Bash tool.
Do NOT push. If the user gave any guidance, follow it: $ARGUMENTS`,
  },
  {
    name: "create-pr",
    description: "Abrir un pull request para la rama actual (gh CLI)",
    body: `Open a pull request for the current branch.
1. Review the changes with GitStatus, GitDiff and GitLog.
2. If the current branch is the repository's default branch (main, master…), first create and switch to a new branch with a short descriptive name.
3. Make sure everything is committed (commit any pending changes first, with a clear message).
4. Push the current branch to the remote (set the upstream if needed).
5. Create the PR with the GitHub CLI: \`gh pr create\` with a clear title and a structured body (a "Summary" section and a "Test plan" section).
Confirm the title/body with the user if anything is ambiguous. User guidance: $ARGUMENTS`,
  },
];

export function localizeCommandDescription(
  name: string,
  slashCommands: Record<string, string>,
  fallback: string,
): string {
  return slashCommands[name] ?? fallback;
}

const PROMPT_COMMAND_NAMES = new Set(BUILTIN_PROMPT_COMMANDS.map((c) => c.name));

export function matchBuiltinPromptCommand(message: string): { cmd: PromptCommand; args: string } | null {
  const m = /^\/([A-Za-z0-9_:-]+)\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!PROMPT_COMMAND_NAMES.has(name)) return null;
  const cmd = BUILTIN_PROMPT_COMMANDS.find((c) => c.name === name)!;
  return { cmd, args: m[2].trim() };
}

export function resolvePromptCommand(cmd: PromptCommand, args: string): string {
  return cmd.body.replace(/\$ARGUMENTS\b/g, args.trim());
}

export interface SlashToken {
  query: string;
  startPos: number;
}

const SLASH_RE = /^\/([A-Za-z0-9_:-]*)$/;

export function getSlashToken(text: string, cursor: number): SlashToken | null {
  const before = text.slice(0, cursor);
  const m = SLASH_RE.exec(before);
  if (!m) return null;
  return { query: m[1] ?? "", startPos: 0 };
}

export function applySlashSuggestion(
  text: string,
  cursor: number,
  _token: SlashToken,
  name: string,
): { value: string; cursor: number } {
  const replacement = `/${name} `;
  const value = replacement + text.slice(cursor);
  return { value, cursor: replacement.length };
}

export const MAX_SLASH_SUGGESTIONS = 10;

function scoreName(name: string, query: string): number | null {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n.startsWith(q)) return 100 - name.length * 0.1;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] !== q[qi]) continue;
    score += 1;
    if (i === prev + 1) score += 3;
    prev = i;
    qi++;
  }
  if (qi < q.length) return null;
  return score - name.length * 0.1;
}

export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) {
    return [...commands].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SLASH_SUGGESTIONS);
  }
  const scored: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of commands) {
    const s = scoreName(cmd.name, query);
    if (s !== null) scored.push({ cmd, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SLASH_SUGGESTIONS).map((s) => s.cmd);
}
