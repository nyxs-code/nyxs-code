import { invoke } from "@/lib/ipc";

// Getting a remote machine ready to run a project's Node dev server: what can be done without
// the user is done, and the one thing that adds a program to their machine, Node, asks first.

export interface RemoteProjectCheck {
  node: string | null;
  canInstallNode: boolean;
  nodeMajor: number | null;
  packageDir: string | null;
  installCommand: string | null;
  manager: string | null;
  managerFound: boolean;
  modulesPresent: boolean;
}

export type PrepStep = "node" | "deps" | "start";

/** What the tab shows while a machine is prepared. `current` is null while it waits for the user. */
export interface ServerPrep {
  name: string;
  nodeMajor: number | null;
  steps: PrepStep[];
  current: PrepStep | null;
  /** Where dependencies go, as the project shows it. */
  depsDir: string | null;
}

/** A program the server needs that the machine doesn't have and Nyxs can't install. */
export class MissingProgramError extends Error {
  readonly program: string;
  constructor(program: string, message: string) {
    super(message);
    this.name = "MissingProgramError";
    this.program = program;
  }
}

const NODE_PROGRAM = /^(node|npm|npx|yarn|pnpm|bun|bunx)(\.cmd|\.exe)?$/i;

/** Whether a command starts with a program of the Node world, which this can get ready. */
export function runsOnNode(command: string): boolean {
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const program = first?.[1] ?? first?.[2] ?? first?.[3] ?? "";
  return NODE_PROGRAM.test(program.split(/[\\/]/).pop() ?? "");
}

/** The program a shell says it couldn't find in a failed server's output. */
export function missingProgram(output: string): string | null {
  return (
    output.match(/(?:^|:\s)([\w.+-]+): (?:command )?not found\s*$/m)?.[1] ??
    output.match(/command not found: ([\w.+-]+)\s*$/m)?.[1] ??
    output.match(/The term '([^']+)' is not recognized/)?.[1] ??
    null
  );
}

const lastLines = (text: string, n: number) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join("\n");

/** Runs an install in a background shell, whose output the tab shows, until it ends. */
async function runToEnd(command: string, cwd: string, description: string, onShell: (id: string, started: boolean) => void): Promise<void> {
  const { id } = await invoke<{ id: string }>("agent_run_background", { command, cwd, description, env: null });
  onShell(id, true);
  let output = "";
  let after = 0;
  for (;;) {
    const r = await invoke<{ output: string; nextOffset: number; status: string; code: number | null }>("agent_bg_output", { id, after, waitMs: 1000 });
    output = (output + r.output).slice(-8000);
    after = r.nextOffset;
    if (r.status === "running") continue;
    if (r.code === 0) return;
    throw new Error(lastLines(output, 8) || `${description} (${r.code ?? "?"})`);
  }
}

/** What's in `dir` relative to the project, to name it without the machine's whole path. */
function shownDir(dir: string | null, workspace: string): string | null {
  if (!dir) return null;
  const root = workspace.replace(/\/+$/, "");
  if (dir === root) return root.split("/").pop() ?? root;
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}

const projectCheck = (cwd: string, workspace: string) =>
  invoke<RemoteProjectCheck>("remote_project_check", { cwd, root: workspace }).catch(() => null);

/** Leaves the machine ready to start the server in `cwd`. Answers false if the user said no.
 *  A machine it can't look at (Windows, a failed check) goes on: starting the server reports it. */
export async function prepareRemoteServer(o: {
  name: string;
  cwd: string;
  workspace: string;
  labels: { node: string; deps: string };
  onPrep: (prep: ServerPrep) => void;
  confirm: () => Promise<boolean>;
  onShell: (id: string, started: boolean) => void;
}): Promise<boolean> {
  let check = await projectCheck(o.cwd, o.workspace);
  if (!check) return true;
  const lacksDeps = (c: RemoteProjectCheck) => !!c.installCommand && !c.modulesPresent;
  const needsNode = !check.node;
  if (!needsNode && !lacksDeps(check)) return true;
  if (needsNode && !check.canInstallNode) throw new MissingProgramError("Node.js", "node: not found");

  const steps: PrepStep[] = [...(needsNode ? (["node"] as const) : []), ...(lacksDeps(check) ? (["deps"] as const) : []), "start"];
  const prep: ServerPrep = { name: o.name, nodeMajor: check.nodeMajor, steps, current: null, depsDir: shownDir(check.packageDir, o.workspace) };

  if (needsNode) {
    o.onPrep(prep);
    if (!(await o.confirm())) return false;
    o.onPrep({ ...prep, current: "node" });
    const command = await invoke<string>("remote_node_install_command", { major: check.nodeMajor });
    await runToEnd(command, o.workspace, o.labels.node, o.onShell);
    check = (await projectCheck(o.cwd, o.workspace)) ?? check;
  }
  if (lacksDeps(check)) {
    if (!check.managerFound) throw new MissingProgramError(check.manager ?? "npm", `${check.manager}: not found`);
    o.onPrep({ ...prep, current: "deps" });
    await runToEnd(check.installCommand ?? "", check.packageDir ?? o.cwd, o.labels.deps, o.onShell);
  }
  o.onPrep({ ...prep, current: "start" });
  return true;
}
