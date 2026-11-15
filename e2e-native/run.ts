// Native end-to-end tests: the real app (Rust backend, capabilities, the PowerShell host, the
// window's WebView2) driven over WebDriver, against a temporary data folder and project, with
// the model answered by a local scripted server. See e2e-native/README.md.
//
//   npm run test:e2e-native            build the test app, then run
//   npm run test:e2e-native -- --no-build

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_EXE, SERVER_PORT, build } from "./build.mjs";
import { nativeDriver, tauriDriver } from "./drivers.mjs";
import { FakeServer, MODEL_ID, USER } from "./fakeServer.ts";

const DRIVER_PORT = Number(process.env.NYXS_E2E_NATIVE_DRIVER_PORT ?? 4444);
const WD = `http://127.0.0.1:${DRIVER_PORT}`;
const ENTER = "";

// ── A minimal W3C WebDriver client ───────────────────────────────────────

type ElementRef = { "element-6066-11e4-a52e-4f735466cecb": string };

async function wd<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WD}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { value: T & { error?: string; message?: string } };
  if (!res.ok || (json.value && typeof json.value === "object" && "error" in json.value && json.value.error)) {
    throw new Error(`WebDriver ${method} ${url}: ${json.value?.error} ${json.value?.message ?? ""}`);
  }
  return json.value;
}

class Session {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }

  static async start(app: string): Promise<Session> {
    const value = await wd<{ sessionId: string }>("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app } } },
    });
    return new Session(value.sessionId);
  }

  execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return wd<T>("POST", `/session/${this.id}/execute/sync`, { script, args });
  }

  executeAsync<T>(script: string, ...args: unknown[]): Promise<T> {
    return wd<T>("POST", `/session/${this.id}/execute/async`, { script, args });
  }

  click(el: ElementRef): Promise<unknown> {
    return wd("POST", `/session/${this.id}/element/${Object.values(el)[0]}/click`, {});
  }

  type(el: ElementRef, text: string): Promise<unknown> {
    return wd("POST", `/session/${this.id}/element/${Object.values(el)[0]}/value`, { text });
  }

  /** The window as a PNG. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await wd<string>("GET", `/session/${this.id}/screenshot`), "base64");
  }

  end(): Promise<unknown> {
    return wd("DELETE", `/session/${this.id}`).catch(() => undefined);
  }

  /** Polls `script` (a function body returning a value) until it's truthy. */
  async waitFor<T>(what: string, script: string, timeoutMs = 30_000, ...args: unknown[]): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.execute<T>(script, ...args);
        if (last) return last as T;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }

  /** A button (or role=button/option) whose accessible name or text is `name`. */
  button(name: string, timeoutMs?: number): Promise<ElementRef> {
    return this.waitFor<ElementRef>(
      `the "${name}" button`,
      `const name = arguments[0];
       const els = [...document.querySelectorAll("button, [role=button], [role=option]")];
       return els.find((b) => b.offsetParent !== null && ((b.getAttribute("aria-label") || "").trim() === name || b.textContent.trim() === name)) || null;`,
      timeoutMs,
      name,
    );
  }

  /** Clicks a permission card's button and waits for that card to go, so the next card found
   *  is a new one and not this one on its way out. */
  async answerCard(label: string): Promise<void> {
    const el = await this.button(label, 60_000);
    await this.click(el);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if (await this.execute<boolean>("return arguments[0].offsetParent === null", el)) return;
      } catch (e) {
        // WebDriver calls an element that left the page "stale": the card is gone.
        if (String(e).includes("stale element")) return;
        throw e;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the card answered with "${label}" didn't close`);
  }

  /** Whether some visible element's own text contains `text`. */
  hasText(text: string): Promise<boolean> {
    return this.execute<boolean>(
      `const t = arguments[0];
       const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
       for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(t) && n.parentElement?.offsetParent !== null) return true;
       return false;`,
      text,
    );
  }

  waitForText(text: string, timeoutMs?: number): Promise<boolean> {
    return this.waitFor<boolean>(`the text "${text}"`, `
      const t = arguments[0];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(t) && n.parentElement?.offsetParent !== null) return true;
      return false;`, timeoutMs, text);
  }
}

// ── The run ──────────────────────────────────────────────────────────────

/** An unsigned session token: the app only decodes it, and /api/me is the scripted server. */
function sessionToken(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ uid: String(USER.id), email: USER.email, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
}

function startDriver(dataDir: string, native: string | null): Promise<ChildProcess> {
  const args = ["--port", String(DRIVER_PORT), ...(native ? ["--native-driver", native] : [])];
  const child = spawn(tauriDriver(), args, {
    // The app inherits this environment from the drivers: its own data folder.
    env: { ...process.env, NYXS_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.env.NYXS_E2E_NATIVE_VERBOSE && process.stdout.write(`[driver] ${d}`));
  child.stderr?.on("data", (d) => process.env.NYXS_E2E_NATIVE_VERBOSE && process.stderr.write(`[driver] ${d}`));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = async () => {
      try {
        await fetch(`${WD}/status`);
        resolve(child);
      } catch {
        if (Date.now() > deadline) reject(new Error("tauri-driver didn't start"));
        else setTimeout(poll, 200);
      }
    };
    child.once("exit", (code) => reject(new Error(`tauri-driver exited (${code})`)));
    void poll();
  });
}

type Check = { name: string; run: () => Promise<void> };

async function main() {
  if (!process.argv.includes("--no-build")) build();
  if (!existsSync(APP_EXE)) throw new Error(`${APP_EXE} is missing: run without --no-build.`);

  const root = mkdtempSync(path.join(tmpdir(), "nyxs-e2e-native-"));
  const dataDir = path.join(root, "data");
  const project = path.join(root, "project");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  // A .txt: no formatter or language server runs after the edit (a fresh profile would install
  // and start them, which takes a varying while); the test is about the real edit on disk.
  const appFile = path.join(project, "notes.txt");
  writeFileSync(appFile, "greeting: hello\n");

  const server = new FakeServer();
  let driver: ChildProcess | null = null;
  let session: Session | null = null;
  const results: { name: string; ok: boolean; error?: string }[] = [];
  let keep = !!process.env.NYXS_E2E_NATIVE_KEEP;

  try {
    await server.start(SERVER_PORT);
    driver = await startDriver(dataDir, await nativeDriver());
    session = await Session.start(APP_EXE);
    const s = session;

    // Signed in as the test user, with the scripted model as a custom provider and the temp
    // project open. Secrets go to the data folder's secrets.json (NYXS_DATA_DIR), the rest to
    // this window's own WebView2 profile.
    // The window starts on a blank page (which also gets __TAURI_INTERNALS__, but whose calls
    // the IPC refuses for lack of an origin) and then loads the app.
    await s.waitFor(
      "the app to load",
      "return !!window.__TAURI_INTERNALS__ && location.protocol.startsWith('http') && document.readyState === 'complete'",
      60_000,
    );
    const uid = String(USER.id);
    const seeded = await s.executeAsync<unknown>(
      `const [token, uid, settings, model, ws, done] = arguments;
       const invoke = window.__TAURI_INTERNALS__.invoke;
       (async () => {
         await invoke("nyxs_secret_set", { account: "auth:session", secret: token });
         await invoke("nyxs_secret_set", { account: "provider:" + uid + ":custom", secret: "sk-native" });
         localStorage.setItem("nyxs.language.v1", "en-US");
         localStorage.setItem("optimicer.providers.adopted.v1", "1");
         localStorage.setItem("optimicer.settings.v1::" + uid, JSON.stringify(settings));
         localStorage.setItem("optimicer.selectedModel.v1::" + uid, model);
         localStorage.setItem("optimicer.workspace.v1::" + uid, ws);
         localStorage.setItem("optimicer.recentWorkspaces.v1::" + uid, JSON.stringify([ws]));
         done(true);
       })().catch((e) => done(String(e)));`,
      sessionToken(),
      uid,
      {
        custom: {
          baseUrl: `http://127.0.0.1:${SERVER_PORT}/v1`,
          models: [{ id: `custom:${MODEL_ID}`, apiModel: MODEL_ID, name: "Native model", provider: "custom" }],
          enabled: [`custom:${MODEL_ID}`],
        },
      },
      `custom:${MODEL_ID}`,
      project,
    );
    if (seeded !== true) throw new Error(`Couldn't sign in and set up the app: ${String(seeded)}`);
    await s.execute("location.reload()");

    const checks: Check[] = [
      {
        name: "the app starts signed in with the test project open",
        run: async () => {
          const box = await s.waitFor<ElementRef>("the composer", `return document.querySelector('textarea[aria-label="Type your coding request…"]')`, 60_000);
          if (!box) throw new Error("no composer");
          // The NYXS.md offer for a new project, when it shows.
          const notNow = await s.button("Not now", 3000).catch(() => null);
          if (notNow) await s.click(notNow);
        },
      },
      {
        name: "a turn runs a real command through the shell host and edits a file, asking first",
        run: async () => {
          server.queue(
            { tools: [{ name: "Bash", args: { command: "echo nyxs-native-ok", description: "Say hello" } }] },
            { tools: [{ name: "Read", args: { file_path: appFile } }] },
            { tools: [{ name: "Edit", args: { file_path: appFile, old_string: "hello", new_string: "hola" } }] },
            { text: "Native turn done." },
          );
          const box = await s.waitFor<ElementRef>("the composer", `return document.querySelector('textarea[aria-label="Type your coding request…"]')`);
          await s.type(box, `Say hello and translate the greeting${ENTER}`);

          // The command needs approval: the permission card, answered like a user would. The edit
          // asks too, in a card of its own once the first one is gone.
          await s.answerCard("Allow once");
          await s.answerCard("Allow once");
          await s.waitForText("Native turn done.", 60_000);

          const results = server.allToolResults().join("\n");
          if (!results.includes("nyxs-native-ok")) throw new Error(`the command's output didn't reach the model: ${results.slice(0, 400)}`);
          const onDisk = readFileSync(appFile, "utf8");
          if (onDisk !== "greeting: hola\n") throw new Error(`notes.txt on disk: ${JSON.stringify(onDisk)}`);
        },
      },
      {
        name: "the Files panel reads the edited file from disk",
        run: async () => {
          await s.click(await s.button("Files"));
          // The file's row in the panel's tree (the panel is the one with the "Filter…" box; the
          // chat lists the file too): a button whose name label is notes.txt, next to its icon.
          const row = await s.waitFor<ElementRef>(
            "notes.txt in the Files panel",
            `const filter = document.querySelector('input[placeholder^="Filter"]');
             let panel = filter;
             while (panel && !panel.querySelector('button span.truncate')) panel = panel.parentElement;
             if (!panel) return null;
             return [...panel.querySelectorAll("button")].find((b) => b.querySelector("span.truncate")?.textContent === "notes.txt") || null;`,
            30_000,
          );
          await s.click(row);
          await s.waitForText("greeting: hola", 30_000);
        },
      },
    ];

    for (const check of checks) {
      try {
        await check.run();
        results.push({ name: check.name, ok: true });
        console.log(`  ✓ ${check.name}`);
      } catch (e) {
        results.push({ name: check.name, ok: false, error: e instanceof Error ? e.message : String(e) });
        console.log(`  ✗ ${check.name}\n      ${e instanceof Error ? e.message : e}`);
        // What the window showed, next to the run's data, which is kept.
        try {
          writeFileSync(path.join(root, "failure.png"), await s.screenshot());
          writeFileSync(path.join(root, "failure.txt"), await s.execute<string>("return document.body.innerText"));
          console.log(`      screenshot and text in ${root}`);
          keep = true;
        } catch {
          // The window may be gone already.
        }
        break;
      }
    }
  } finally {
    await session?.end();
    // Only processes this run started, by handle: never anything by name.
    driver?.kill();
    await server.stop();
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    else console.log(`  kept ${root}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
