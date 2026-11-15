---
name: nyxs-rust-backend
description: Conventions for the Nyxs Rust backend (src-tauri/). Use whenever adding or changing a #[tauri::command], code that reads or writes files on disk, a Mutex/static state, persisted JSON (indexes, settings, sessions), a capability in src-tauri/capabilities, or Rust tests.
---

# Rust backend conventions in Nyxs

## Commands: async or not

In Tauri 2 a plain `#[tauri::command]` runs **on the main thread**: while it works the whole
window freezes. A command declared `#[tauri::command(async)]` runs on a worker thread.

- **Reads and anything slow are `#[tauri::command(async)]`:** reading files, PDFs or images,
  listing folders, parsing JSON, walking the project, spawning a process and waiting for it.
  Heavy work inside an `async fn` goes in `tauri::async_runtime::spawn_blocking`.
- **Writes whose order matters need their own ordering before they go async.** The chat saves in
  `account.rs` are async behind a common lock, and `chatStore.ts` queues writes per file so the
  next save of a chat only goes once the previous one answered. Don't make an ordered write
  async without a lock or queue like that: on the pool, two writes can race.
- Commands that only touch memory (a `HashMap` behind a mutex) can stay sync.

## Writing files

- Persisted state is written atomically with `crate::agent::text_io::write_atomic` (temporary
  file + `rename`), never `fs::write` on the real path. A crash in the middle must leave the old
  file whole.
- Don't silently replace state you can't read. Only "not found" reads as empty; any other read
  error is returned as an error, so the caller doesn't save over a file it never read (the chat
  index and chats in `account.rs`, sessions in `sessions.rs`). A JSON that fails to parse is
  moved aside (`<name>.json.corrupt`) and reported. A cache that can be rebuilt from scratch, like
  the semantic index (`load_index` in `rag.rs`), may then start empty; user data may not.
  `unwrap_or_default()` on a read or parse result is a bug.
- Big files read often (indexes) are cached in memory and checked against the file's size and
  mtime, so another window's write is still seen (`rag.rs`, `Cached`).

## Mutexes and global state

- Never `.lock().unwrap()`. A panic while a lock is held poisons the mutex, and every later
  `unwrap()` panics too, taking the commands down with it. Use
  `.lock().unwrap_or_else(|e| e.into_inner())`.
- Global state lives in `static X: OnceLock<Mutex<…>>` with a small accessor function.

## Security boundaries

- Commands that run programs check a backend allowlist (`EXEC_ALLOWED` in `agent/shell/run.rs` only
  lets `agent_exec` run `git` and `gh`). Don't widen it from the frontend.
- Paths the agent may touch go through `agent/scope.rs` (canonicalized, `..` rejected).
- HTTP scopes in `src-tauri/capabilities/*.json` use URLPattern: a literal IP prefix such as
  `http://192.168.*:*/*` never matches. Use regex groups like
  `http://(192\\.168\\.\\d{1,3}\\.\\d{1,3}):*/*`. `security_config.rs` tests the capability with the
  plugin's own parser.

## Errors

Every message in the backend is English: the agent reads it, logs keep it, and it is the
fallback text. Keep it short and specific (what failed and the path or cause).

- **Errors the user sees in the UI** return `Result<_, CmdError>` (`src-tauri/src/error.rs`). Add a
  constructor there with its code and params, add the code to `errors` in
  `src/locales/types.ts` and the 10 locale files, and show it in the UI with
  `localizedError(e)` (`src/lib/i18n.ts`) or `describeError(e, t)` (`src/lib/ipc.ts`).
  `backendErrors.test.ts` fails when a code has no text in the locales.
- **Errors only the agent or the logs read** stay `Result<_, String>`. `?` converts between
  the two either way (`From<String>` gives code `other`; `From<CmdError> for String` keeps the
  message).
- Don't add a code for an error the frontend swallows (`.catch(() => …)`): it would never be
  shown.
- The frontend imports `invoke` from `@/lib/ipc`, never from `@tauri-apps/api/core`: the
  wrapper turns a `CmdError` into a `BackendError` whose `String(e)` is the message.

## Tests and checks

- Tests that write project state set `NYXS_PROJECTS_ROOT` to a temp folder and clean up even
  when they fail (`Drop`), so nothing lands in `~/.nyxs/projects/`.
- Before finishing a change in `src-tauri/`:
  - `cargo clippy --all-targets --locked` with no warnings
  - `cargo test --lib` all green (CI runs both on Windows, Linux and macOS and fails on any)
  - Code under `cfg(target_os = "macos")`: `powershell -File scripts/check-macos.ps1` runs clippy
    for macOS from Windows (nothing is linked, so no Mac or SDK is needed)
- Files mix CRLF and LF. Edit with tools that keep each line's ending; check
  `git diff --stat` shows only the lines you meant to change.
