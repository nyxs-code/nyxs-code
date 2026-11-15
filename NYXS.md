# Nyxs

## Overview

Nyxs es un agente de IA de escritorio para programar (Tauri 2 + React 19). La interfaz y el
bucle del agente viven en `src/` (TypeScript); el acceso al sistema (archivos, shell, git en
sombra, navegador integrado, LSP, RAG, secretos) en `src-tauri/` (Rust). Qué hace la app, cómo
arrancarla y cómo se publica: `README.md`. Guías por tarea: `.claude/skills/`.

## Conventions

### Almacenamiento por proyecto — NO ensuciar el proyecto del usuario

REGLA: el **estado generado por la máquina** (índices, caches, backups, worktrees,
y cualquier artefacto que NO sea creado a mano por el usuario) NUNCA debe vivir
dentro del proyecto del usuario. Va a la carpeta de datos de la app, organizado
por proyecto, junto a las sesiones:

```
~/.nyxs/projects/<proyecto-codificado>/<feature>/...
```

- Fuente única de la convención (Rust): **`src-tauri/src/project_paths.rs`** →
  `project_data_dir(workspace)` y `project_feature_dir(workspace, "<feature>")`.
  Úsalas SIEMPRE para ubicar estado nuevo (no construyas rutas a mano).
- La codificación del path coincide con `agent.rs::encode_project_path` (sesiones),
  así todo el estado de un proyecto cae en la misma carpeta.
- Override de tests: env `NYXS_PROJECTS_ROOT` (apúntalo a temp en los tests para
  no tocar el `~/.nyxs` real).
- Ya migrados a este esquema: `rag/` (índice), `worktrees/`, `file-history/`.

EXCEPCIÓN — lo que SÍ vive dentro del proyecto (`<proyecto>/.nyxs/`), porque es
config INTENCIONAL y compartible/committeable (NO es basura):
`settings.json` (capa "project"), `settings.local.json` (capa "local"),
`skills/`, `NYXS.md`, `plugins/`.

Al añadir una feature nueva que genere archivos: si es estado/cache → usa
`project_feature_dir`; si es config que el usuario edita/commitea → `<proyecto>/.nyxs/`.

### Code style — comments, no filler blank lines

Comments are allowed. Use them to explain the *why*: a non-obvious constraint,
a workaround, or behavior a reader wouldn't guess from the code. Doc comments
(`///`, JSDoc) on exported functions and types are welcome. Avoid comments that
just restate the code, section dividers, and commented-out code. Match the
comment density of the surrounding code.

Keep at most one consecutive blank line, no blank line at the start of a file,
and a single trailing newline; never alter whitespace inside template literals
or multi-line strings.

## User decisions — do not change unless the user asks

The user asked for each of these after a bug or a deliberate choice. Don't revert, "improve" or
work around them on your own; if a task seems to need it, ask the user first.

### Sessions and Recents

- **A deleted session stays deleted.** `nyxs_session_delete` (`src-tauri/src/agent/sessions.rs`)
  writes a mark in `<data dir>/.deleted-sessions/<id>` *before* removing the files. Every session
  write (`append`, `write_transcript`, `write_meta`) refuses a marked id, and `nyxs_list_sessions`
  never lists one (it removes files written around the delete). The frontend keeps the same rule
  in memory (`deletedSessions` in `src/lib/sessionStorage.ts`) and removes the row at once
  (`dropSessions`). Deleted sessions used to come back after a save or a reload.
- **The old project data folder is never read again after its one-time copy.**
  `project_paths.rs` copies `~/.nyxs/projects/<old name>` to the hashed folder once
  (`migrate_legacy`) and that's it. There was a sync every 10 s with the old folder: it slowed
  every session read (it ran under the project's lock) and brought deleted sessions back. Don't
  add any sync, watcher or fallback read of the old folder.
- **Opening a session doesn't save it.** `markChatAsOnDisk` (`useSessionAutosave.ts`) skips the
  autosave of a chat exactly as read from disk, so opening one doesn't move it to the top of
  Recents as "now".
- **Session list refreshes: only the latest applies** (`refreshSeqRef` in `useSessionList.ts`),
  and the sidebar doesn't say "No conversations yet" before the first listing (`sessionsLoaded`).

### Side chat (`src/components/SideChat.tsx`, `src/lib/sideChat.ts`)

- It opens as a view of the right panel (`ViewId` `"sidechat"`), from the ⋮ menu, Ctrl+J or
  `/btw`. Its header has minimize, maximize and close.
- Minimized, it's a card the user drags by its header; on release it snaps to the nearest corner
  of the **chat area** (`[data-side-chat-area]`, between the sidebar and the side panel), never
  over the sidebar or the panel.
- It mirrors the main chat: messages through the same `Message` component, the same
  `ClaudeChatInput` (with `sideChat`, which only hides attach, permission mode and context meter,
  since it runs no tools), and the same scrolling (`useChatScroll`: follows the answer only while
  the user is at the end, so they can scroll up while it writes). Don't give it its own input,
  message look or scroll logic.
- Each session has its own. Switching sessions hides it; coming back shows it again.
- It's only available once the session has messages: the ⋮ entry, `/btw` in the command list,
  Ctrl+J and `/btw` itself do nothing before. (A new session has no id until its first message.)

### Changes view (`src/components/DiffPanel.tsx`, `src/components/diff/load.ts`)

- **No scroll animation** when moving between files: `scrollIntoView` uses `behavior: "instant"`.
  Never `"smooth"`.
- **Opening it must feel instant.** With a previous result it shows that one and refreshes without
  the spinner; git runs that don't depend on each other run in parallel (`readChanges`); the
  default branch is cached per folder; and hovering the Changes button prefetches
  (`onPrepareView` → `prefetchChanges`). Don't make these reads sequential again.

### Releases

- **No Linux desktop build** in `.github/workflows/release.yml` (nobody uses it). The Linux SSH
  helpers (`remote-helpers`) are still built: remote machines run them.

## Notes
