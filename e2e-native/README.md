# Native end-to-end tests

`e2e/` runs the frontend in a browser against a simulated Tauri backend. These tests drive the
**real app** instead (the Rust commands, the capabilities ACL, the PowerShell host, the
window's WebView2) over WebDriver, so they catch what the simulated suite can't: a command whose
signature changed, a capability that blocks a call, a shell host that doesn't answer.

```sh
npm run test:e2e-native              # builds the test app, then runs
npm run test:e2e-native -- --no-build
```

Windows and Linux only (tauri-driver has no macOS support).

## What it needs

- `tauri-driver`: `cargo install tauri-driver --locked`.
- Windows: `msedgedriver` for the installed WebView2 runtime's exact version. `drivers.mjs`
  downloads it into `e2e-native/.drivers/` the first time.
- Linux: `WebKitWebDriver` (package `webkit2gtk-driver`) and a display (`xvfb-run`).

## How it stays away from your data

- `build.mjs` builds a separate app: the frontend into `dist-e2e/` with the backend pointed at
  the local test server (`VITE_NYXS_API_BASE`), and a debug `app.exe` in `src-tauri/target-e2e/`
  with its own identifier (`com.nyxs.desktop.e2e`, a second guard) and no installer. A running
  `tauri dev` or the installed Nyxs are never touched.
- `run.ts` starts it with `NYXS_DATA_DIR` set to a fresh temp folder (`src-tauri/src/test_data_dir.rs`).
  The app then keeps `~/.nyxs`, its WebView2 profile and its secrets (a `secrets.json` instead of
  the OS keychain) in that folder, shows no OS notifications and registers no global shortcut.
  With `NYXS_DATA_DIR` set and the installed app's identifier, the app refuses to start.
- The window never covers your screen or takes focus: the test build creates it hidden, and the
  app moves it off every monitor and shows it without activating it
  (`test_data_dir::move_window_off_screen`).
- The model and the Nyxs backend routes (`/api/me`, `/api/title`) are `fakeServer.ts` on
  `127.0.0.1:47731`, answering from a script like `FakeModel` in `e2e/fixtures.ts`.
- Only the processes the run started are stopped, by handle; the temp folder is deleted
  (`NYXS_E2E_NATIVE_KEEP=1` keeps it, `NYXS_E2E_NATIVE_VERBOSE=1` shows the drivers' output).

## What it covers

1. The app starts signed in (a test session token; `/api/me` is the fake server) with a temp
   project open and the scripted model as a custom OpenAI-compatible provider.
2. A turn that runs a real command through the PowerShell host (Bash tool), reads and edits a
   file on disk, each asking first in the permission card.
3. The Files panel reading the edited file back from disk.

The edited file is a `.txt` on purpose: after editing code the agent runs formatters and asks a
language server for diagnostics, which a fresh profile would install and start on the spot (a
varying wait, over the network). Those aren't covered here.

A failed check saves `failure.png` and `failure.txt` (the window's text) next to the run's data,
which is kept. A run takes about a minute once built; the first build in `target-e2e` takes
several.

## CI

Not in CI yet: the job would build the whole app (about 15–20 minutes on a runner) and depends on
the runner's WebView2 version for msedgedriver. Locally it's been run on Windows; Linux needs
`webkit2gtk-driver` and `xvfb-run` and hasn't been tried.
