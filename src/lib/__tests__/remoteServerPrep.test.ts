import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd === "agent_run_background" ? `run ${args.command} in ${args.cwd}` : cmd);
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected ${cmd}`);
    return handler(args);
  }),
}));

import { missingProgram, MissingProgramError, prepareRemoteServer, runsOnNode, type RemoteProjectCheck, type ServerPrep } from "../remoteServerPrep";

const WS = "ssh://build-box/home/dev/app";
const CWD = `${WS}/desktop`;
const READY: RemoteProjectCheck = {
  node: "v24.1.0", canInstallNode: true, nodeMajor: null, packageDir: CWD, installCommand: "npm ci", manager: "npm", managerFound: true, modulesPresent: true,
};

function checks(...answers: Partial<RemoteProjectCheck>[]) {
  handlers.remote_project_check = () => ({ ...READY, ...(answers.length > 1 ? answers.shift() : answers[0]) });
}

function finishes(code: number | null, output = "") {
  handlers.agent_run_background = () => ({ id: "s1" });
  handlers.agent_bg_output = () => ({ output, nextOffset: output.length, status: code === 0 ? "exited" : "failed", code });
}

function run(answer = true) {
  const preps: ServerPrep[] = [];
  const shells: string[] = [];
  const confirm = vi.fn(async () => answer);
  const done = prepareRemoteServer({
    name: "web",
    cwd: CWD,
    workspace: WS,
    labels: { node: "Installing node", deps: "Installing deps" },
    onPrep: (p) => preps.push(p),
    confirm,
    onShell: (id) => shells.push(id),
  });
  return { done, preps, shells, confirm };
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers.remote_node_install_command = () => "install-node";
});

describe("prepareRemoteServer", () => {
  it("does nothing, and asks nothing, when the machine has what it needs", async () => {
    checks({});
    const { done, preps, confirm } = run();
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(["remote_project_check"]);
    expect(preps).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("goes on when it can't look at the machine: starting the server reports what's wrong", async () => {
    handlers.remote_project_check = () => { throw new Error("Windows"); };
    await expect(run().done).resolves.toBe(true);
  });

  it("installs missing dependencies without asking, where the lockfile is", async () => {
    checks({ modulesPresent: false, packageDir: WS });
    finishes(0);
    const { done, preps, shells, confirm } = run();
    await expect(done).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toContain(`run npm ci in ${WS}`);
    expect(shells).toEqual(["s1"]);
    expect(preps.map((p) => p.current)).toEqual(["deps", "start"]);
  });

  it("asks before installing Node, then goes on to the dependencies with it", async () => {
    checks({ node: null, nodeMajor: 22, modulesPresent: false, managerFound: false }, { node: "v22.1.0", nodeMajor: 22, modulesPresent: false });
    finishes(0);
    const { done, preps, confirm } = run();
    await expect(done).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(preps[0]).toMatchObject({ current: null, nodeMajor: 22, steps: ["node", "deps", "start"], depsDir: "desktop" });
    expect(preps.map((p) => p.current)).toEqual([null, "node", "deps", "start"]);
    expect(calls).toEqual([
      "remote_project_check",
      "remote_node_install_command",
      `run install-node in ${WS}`,
      "agent_bg_output",
      "remote_project_check",
      `run npm ci in ${CWD}`,
      "agent_bg_output",
    ]);
  });

  it("installs nothing when the user says no", async () => {
    checks({ node: null });
    const { done, preps } = run(false);
    await expect(done).resolves.toBe(false);
    expect(calls).toEqual(["remote_project_check"]);
    expect(preps).toHaveLength(1);
  });

  it("names what it can't install", async () => {
    checks({ node: null, canInstallNode: false });
    await expect(run().done).rejects.toMatchObject({ program: "Node.js" });
    checks({ modulesPresent: false, manager: "pnpm", installCommand: "pnpm install", managerFound: false });
    const failed = await run().done.catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(MissingProgramError);
    expect((failed as MissingProgramError).program).toBe("pnpm");
  });

  it("reports the end of a failed install's output", async () => {
    checks({ modulesPresent: false });
    finishes(1, "npm WARN x\nnpm ERR! code E404\n");
    await expect(run().done).rejects.toThrow(/E404/);
  });
});

describe("runsOnNode", () => {
  it("knows the Node world's programs, wherever they are", () => {
    for (const c of ["npm run dev", "node x.js", "npx vite", "pnpm dev", "yarn dev", "bun run dev", '"C:\\Program Files\\nodejs\\node.exe" x.js', "/usr/bin/node x"]) {
      expect(runsOnNode(c), c).toBe(true);
    }
    for (const c of ["python -m http.server", "uvicorn app:app", "cargo run", "php -S localhost:8000", "nodemon x"]) {
      expect(runsOnNode(c), c).toBe(false);
    }
  });
});

describe("missingProgram", () => {
  it("reads what each shell says", () => {
    expect(missingProgram("The server closed.\n\n/bin/bash: -c: line 1: uvicorn: command not found")).toBe("uvicorn");
    expect(missingProgram("bash: python3: command not found\n")).toBe("python3");
    expect(missingProgram("sh: 1: vite: not found")).toBe("vite");
    expect(missingProgram("zsh:1: command not found: php")).toBe("php");
    expect(missingProgram("foo : The term 'cargo' is not recognized as the name of a cmdlet")).toBe("cargo");
  });

  it("leaves other failures alone", () => {
    expect(missingProgram("/bin/bash: -c: line 1: syntax error near unexpected token `&'")).toBeNull();
    expect(missingProgram("Error: Cannot find module 'vite'")).toBeNull();
    expect(missingProgram("GET /favicon.ico 404 not found today")).toBeNull();
  });
});
