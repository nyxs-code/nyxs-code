import { describe, expect, it } from "vitest";
import { launchCwd, parseLaunchConfig, scriptPinsPort, stripJsonComments, withPort } from "@/lib/launchConfig";

describe("parseLaunchConfig", () => {
  it("reads Claude Code's launch.json entries", () => {
    const entries = parseLaunchConfig(`{
      "version": "0.0.1",
      "configurations": [
        { "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 1420 },
        { "name": "attach", "url": "http://localhost:1420", "port": 1420 },
        { "name": "web-alt", "runtimeExecutable": "npx", "runtimeArgs": ["vite", "--port", "1430", "--strictPort"], "port": 1430 }
      ]
    }`);
    expect(entries).toMatchObject([
      { name: "dev", command: "npm run dev", url: "http://localhost:1420", port: 1420, cwd: null },
      { name: "attach", command: null, url: "http://localhost:1420", port: 1420, cwd: null },
      { name: "web-alt", command: "npx vite --port 1430 --strictPort", url: "http://localhost:1430", port: 1430, cwd: null },
    ]);
  });

  it("tolerates comments, trailing commas and quotes arguments with spaces", () => {
    const entries = parseLaunchConfig(`{
      // local servers
      "configurations": [
        /* api */ { "name": "api", "runtimeExecutable": "node", "runtimeArgs": ["server dir/index.js"], "url": "http://127.0.0.1:8080/health", },
      ],
    }`, "", true);
    expect(entries).toMatchObject([{ name: "api", command: 'node "server dir/index.js"', url: "http://127.0.0.1:8080/health", port: null, cwd: null }]);
  });

  it("gives a server with no port Desktop's 3000, skips an entry with nowhere to open and a broken file", () => {
    expect(parseLaunchConfig(`{ "configurations": [{ "name": "x", "runtimeExecutable": "npm" }] }`)[0]).toMatchObject({ port: 3000, url: "http://localhost:3000" });
    expect(parseLaunchConfig(`{ "configurations": [{ "name": "x" }] }`)).toEqual([]);
    expect(parseLaunchConfig("not json")).toEqual([]);
  });

  it("keeps // inside strings", () => {
    expect(stripJsonComments(`{"url":"http://x"} // c`)).toBe(`{"url":"http://x"} \n`);
  });

  it("runs a quoted executable with & and starts in the entry's cwd", () => {
    const file = JSON.stringify({
      configurations: [
        {
          name: "storefront-desktop",
          runtimeExecutable: "C:\\Program Files\\nodejs\\node.exe",
          runtimeArgs: ["node_modules/vite/bin/vite.js", "--port", "5174", "--strictPort"],
          cwd: "storefront/desktop",
          port: 5174,
        },
      ],
    });
    const [e] = parseLaunchConfig(file, "", true);
    expect(e.command).toBe('& "C:\\Program Files\\nodejs\\node.exe" node_modules/vite/bin/vite.js --port 5174 --strictPort');
    // The same file on a Linux machine: its own node, in its shell's syntax.
    const [linux] = parseLaunchConfig(file, "ssh://build-box/home/dev/app", false);
    expect(linux.command).toBe("node node_modules/vite/bin/vite.js --port 5174 --strictPort");
    expect(launchCwd("ssh://build-box/home/dev/app", linux)).toBe("ssh://build-box/home/dev/app/storefront/desktop");
    expect(launchCwd("C:\\storefront", e)).toBe("C:\\storefront\\storefront\\desktop");
    expect(launchCwd("/home/me/app", { ...e, cwd: "./web" })).toBe("/home/me/app/web");
    expect(launchCwd("C:\\x", { ...e, cwd: "D:\\other" })).toBe("D:\\other");
    expect(launchCwd("C:\\x", { ...e, cwd: null })).toBe("C:\\x");
  });

  it("writes a Linux or macOS machine's command line for its shell", () => {
    const entry = (runtimeExecutable: string, runtimeArgs: string[]) =>
      parseLaunchConfig(JSON.stringify({ configurations: [{ name: "x", runtimeExecutable, runtimeArgs, port: 3000 }] }), "", false)[0];
    expect(entry("/opt/my tools/node", ["a b.js", "it's"]).command).toBe("'/opt/my tools/node' 'a b.js' 'it'\\''s'");
    expect(entry("C:\\tools\\npm.cmd", ["run", "dev"]).command).toBe("npm run dev");
    expect(entry("D:/nodejs/node.exe", ["x.js"]).command).toBe("node x.js");
    const moved = withPort(entry("C:\\Program Files\\nodejs\\node.exe", ["vite.js", "--port", "3000"]), 3001);
    expect(moved.command).toBe("node vite.js --port 3001");
  });

  it("gives what runs on a remote machine its path there, and keeps the folder's ssh:// name", () => {
    const ws = "ssh://casa/home/me/app";
    const file = JSON.stringify({ configurations: [{ name: "x", runtimeExecutable: "node", runtimeArgs: ["${workspaceFolder}/s.js"], cwd: "${workspaceFolder}/web", env: { ROOT: "${workspaceFolder}" }, port: 1 }] });
    const [e] = parseLaunchConfig(file, ws, false);
    expect(e.args).toEqual(["/home/me/app/s.js"]);
    expect(e.env.ROOT).toBe("/home/me/app");
    expect(launchCwd(ws, e)).toBe("ssh://casa/home/me/app/web");
  });

  it("reads env, autoPort, program/args and ${workspaceFolder}", () => {
    const [e, n] = parseLaunchConfig(JSON.stringify({
      configurations: [
        { name: "api", runtimeExecutable: "npm", runtimeArgs: ["run", "start"], cwd: "${workspaceFolder}/server", port: 8080, env: { NODE_ENV: "development", DEBUG: 1, "BAD KEY": "x", OBJ: {} }, autoPort: false },
        { name: "script", program: "server.js", args: ["--verbose"], port: 4000 },
      ],
    }), "D:\\proj");
    expect(e).toMatchObject({ cwd: "D:\\proj/server", env: { NODE_ENV: "development", DEBUG: "1" }, autoPort: false });
    expect(n).toMatchObject({ command: "node server.js --verbose", exe: "node", args: ["server.js", "--verbose"], autoPort: null });
  });
});

describe("withPort", () => {
  const [e] = parseLaunchConfig(JSON.stringify({ configurations: [{ name: "w", runtimeExecutable: "npx", runtimeArgs: ["vite", "--port", "1430", "--strictPort"], port: 1430, env: { A: "1" } }] }));

  it("rewrites --port, sets PORT and moves the address", () => {
    expect(withPort(e, 1431)).toEqual({ command: "npx vite --port 1431 --strictPort", url: "http://localhost:1431", env: { A: "1", PORT: "1431" } });
    expect(withPort({ ...e, args: ["serve", "-p=1430"] }, 1500).command).toBe("npx serve -p=1500");
  });
});

describe("scriptPinsPort", () => {
  const entry = (args: string[], port = 3000) => ({ ...parseLaunchConfig(JSON.stringify({ configurations: [{ name: "x", runtimeExecutable: "npm", runtimeArgs: args, port }] }))[0] });
  const pkg = (dev: string) => JSON.stringify({ scripts: { dev } });

  it("pins a package-manager script that writes its port, or can't be read", () => {
    expect(scriptPinsPort(entry(["run", "dev"]), pkg("vite --port 3000"))).toBe(true);
    expect(scriptPinsPort(entry(["run", "dev"]), pkg("next dev -p 3000"))).toBe(true);
    expect(scriptPinsPort(entry(["run", "dev"]), null)).toBe(true);
    expect(scriptPinsPort(entry(["run", "missing"]), pkg("vite"))).toBe(true);
  });

  it("lets it move when the script reads PORT or the port is in runtimeArgs", () => {
    expect(scriptPinsPort(entry(["run", "dev"]), pkg("vite"))).toBe(false);
    expect(scriptPinsPort(entry(["run", "dev", "--port", "3000"]), pkg("vite --port 3000"))).toBe(false);
    const node = parseLaunchConfig(JSON.stringify({ configurations: [{ name: "n", program: "s.js", port: 3000 }] }))[0];
    expect(scriptPinsPort(node, null)).toBe(false);
  });
});
