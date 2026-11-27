# Projects with threads, and threads in the Nyxs cloud

Status: in progress (started 2026-11-26). Owner: the coordinating session. This file is the
contract the three work streams build against; change it here first, then in code.

## What the user gets

- **Projects** (sidebar entry "Proyectos · Beta"). A project is one continuous conversation with
  a **coordinator** agent, plus its repositories, instructions and memory. The user asks for
  things as they come up. The coordinator answers quick questions itself and opens a **thread**
  for each real task (or several at once for unrelated tasks in one message).
- **Threads** are Nyxs sessions with their own context. Each one shows in the project
  conversation as a card with its state, and in the **overview panel** (right side) grouped as
  *Te esperan* (needs input) · *Trabajando* · *Para revisar* · *Resueltos* (+ *Fallidos*).
  Opening a thread shows it as a normal chat the user can read, write to, approve and stop.
- **Where a thread runs**: on **this computer** (a worktree of the project's folder) or in the
  **Nyxs cloud** (an isolated container on tnp-ai). Cloud threads keep working with the laptop
  closed and report back when the app opens again. Every provider and model the user has
  configured works in both places.
- **Reporting back**: a thread posts to the project conversation when it finishes, fails or needs
  the user; the coordinator relays and summarizes. Questions to the user are decision cards
  (2–4 options) that can be answered from the project conversation.

Reference design: Claude's Projects ("hearth": coordinator session + `hearth-thread` sessions,
tools `start_thread_session`, `message_thread`, `fetch_thread`, `ask_decision`,
`set_thread_resolved`, `update_memory`, statuses resolved/failed/working/needs_input/archived/idle,
thread lifecycle quiet 3 days / auto-resolve 7 days). The mockup the user approved is option 1 of
the design conversation (project view with coordinator chat, thread cards, overview panel).

## Phase 1 — Projects and local threads (app, `E:\optimicer`)

### Data

- `Project` (`src/lib/projects/`): `{ id, name, createdAt, repos: ProjectRepo[], instructions
  (≤16k chars), defaults: { model, effort, where: "local" | "cloud" }, coordinatorChatId,
  memoryPath }`. `ProjectRepo = { path?: string; gitUrl?: string; branch?: string }` (a local
  folder, a remote URL, or both).
- Stored as machine state of the app, not inside any repo: `<app data>/project-hubs/<id>.json`
  through a new Rust command pair (`nyxs_project_hubs_list/save/delete`), following
  `project_paths.rs` conventions (env override `NYXS_PROJECTS_ROOT` in tests). Memory:
  `<app data>/project-hubs/<id>/MEMORY.md`.
- Sessions gain optional fields (session meta, `src/lib/sessionStorage.ts` + `agent/sessions.rs`
  meta): `projectId`, `projectRole: "coordinator" | "thread"`, `threadStatus`, `threadTitle`,
  `threadLocation: { kind: "local"; workspace: string; worktree?: string } | { kind: "cloud";
  cloudThreadId: string }`, `parentMessageId` (the coordinator message that opened it).
  Thread sessions are nested under the coordinator (existing `parentId` / `sessionTree.ts`).

### Coordinator and thread tools

Built on the existing session machinery (`sessionTools.ts`, `create_session`, `send_to_session`,
delivery states). New tools, offered only in project sessions (both the built-in models and the
CLI agents through the `nyxs-sessions` MCP server):

- coordinator: `start_thread { title, instructions, where?: "local" | "cloud", model? }`,
  `message_thread { threadId, text }`, `read_thread { threadId, lastN? }`, `list_threads`,
  `set_thread_status { threadId, status: "resolved" | "idle" }`, `ask_decision { question,
  options: {label, consequence?}[2..4], recommended? }`, `update_memory { text }`.
- thread: `report { text, status?: "working" | "needs_input" | "review" | "failed" }` — posts a
  card into the coordinator conversation and updates the thread status. A thread ending its turn
  without reporting is treated as `review` (Para revisar) with its last message as preview.
- The coordinator prompt: route quick questions itself; one thread per independent task; reuse a
  thread for follow-ups in its area; never do long work itself; keep `MEMORY.md` short.
  Project instructions + memory are injected into every project session's system prompt.

### UI

- Sidebar: "Proyectos" (badge Beta) above "Programadas"; under a "Proyectos" section, one row per
  project with a status dot (amber = something waits on the user, blue = working).
- Project page: header (name, repo chips, where chips), coordinator chat (normal `ChatPane`) with
  thread cards rendered for `report` / `start_thread` tool results, composer placeholder
  "Pide algo al proyecto…", and the overview panel (tabs Hilos · Archivos · Memoria ·
  Programadas). Clicking a thread opens its session in place (breadcrumb "Proyecto › Hilo").
- Empty state like Claude's: "Un proyecto ahora es una conversación…" with "Nuevo proyecto";
  creation dialog: name, folder(s)/repo URL, instructions, default model and where.
- Follow the repo's UI skills (corner radius, dialogs, dropdowns, tooltips) and i18n (10 locales).

## Phase 2 — The Nyxs cloud (tnp-ai)

### Pieces

1. **Cloud API** in `E:\nyxs-backend\server` (Express, existing `requireAuth` with the Nyxs
   account token, Postgres `nyxsdev`): tables `cloud_threads`, `cloud_events`, `cloud_secrets`.
2. **Runner** (`E:\nyxs-backend\cloud-runner`, a Node service deployed on tnp-ai, not public):
   claims queued turns, runs each in a sandboxed container, streams events into the API's DB.
3. **Worker image** `nyxs-cloud-worker`: Linux build of Nyxs run headless (`nyxs --headless`)
   under Xvfb, plus git, gh, node and the agent CLIs (claude, codex, gemini…) so CLI providers
   work too.

### API (all under `https://api.nyxs.dev/api/cloud`, Bearer = Nyxs account token)

- `PUT /secrets` `{ items: [{ key, value }] }` → stores the user's provider credentials
  encrypted (AES-256-GCM, key from env `CLOUD_SECRETS_KEY`); `GET /secrets` → keys only, never
  values; `DELETE /secrets/:key`. Key names (`src/lib/cloud/cloudCredentials.ts`):
  env var names, exactly what the turn's container gets: `<ID>_API_KEY` for a provider's API key
  (id upper-cased, every character other than a letter or digit as `_`: `ANTHROPIC_API_KEY`,
  `MINIMAX_ANTHROPIC_API_KEY`), `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`),
  `GITHUB_TOKEN` (cloning, pushing and PRs). Codex runs with `OPENAI_API_KEY`: its ChatGPT
  sign-in renews itself, so a copy in the cloud would sign the user's computer out. Local providers (Ollama, LM
  Studio, a LAN base URL) and agent CLIs other than Claude Code and Codex don't run in the cloud.
  `settings` in a thread is `{ providers: { <providerId>: <provider settings without apiKey> } }`.
- `POST /threads` `{ projectId, title, instructions, repo: { url, branch? }, model: { id,
  provider, effort? }, settings: <sanitized Nyxs settings: providers/models, no secrets>,
  projectInstructions, memory }` → `{ id, status: "queued" }`.
- `GET /threads?projectId=` → `[{ id, projectId, title, status, updatedAt, preview, prUrl? }]`.
- `GET /threads/:id/events?after=<seq>&wait=25` → long-poll; `{ events: [{ seq, at, type, data
  }] }` where `type` is the headless `--format json` event type (text, tool, tool_result,
  status, report, error, done) — the app renders them as a chat.
- `POST /threads/:id/messages` `{ text }` → queues a follow-up turn (the thread continues from
  its saved session). `POST /threads/:id/stop`. `DELETE /threads/:id`.
- Status values match the app: `queued | working | needs_input | review | resolved | failed |
  stopped`.

### Sandbox rules (tnp-ai is shared with the firm's Kelly — never restart Docker there)

- One container per running turn, from `nyxs-cloud-worker:<version>`; the thread's workspace is
  a named volume `nyxs-cloud-<threadId>` kept between turns (deleted with the thread or after
  14 days idle).
- `--network nyxs-cloud` (a bridge created once), with `DOCKER-USER` iptables rules dropping
  traffic from that subnet to `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10` and the
  host, so containers reach the internet but nothing of the office LAN, Kelly, MinIO or Postgres.
- `--cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --cpus 2 --memory 4g
  --memory-swap 4g`, non-root user, no Docker socket, no host mounts. Disk: volume size check by
  the runner (kill + fail the turn over 10 GB).
- Limits per account: 2 running turns, 30 turns/day, 60 min per turn (configurable env).
- Secrets go into the container as env vars for that turn only; the runner never logs them.
- The runner talks to the containers over stdin/stdout only (job JSON in, JSONL events out).

### Runner ↔ worker contract (one container run = one turn)

- Command: `docker run --rm -i <sandbox flags> -v nyxs-cloud-<threadId>:/work -e <secrets>
  nyxs-cloud-worker:<version>` (entrypoint `nyxs-cloud-turn`).
- stdin: one JSON line, the job:
  `{ "threadId", "turn": <n, 1-based>, "prompt": <the instructions or the user's follow-up>,
  "repo": { "url", "branch"? }, "workBranch": "nyxs/<slug>-<short id>", "model": { "id",
  "provider", "effort"? }, "settings": <sanitized Nyxs settings>, "projectInstructions",
  "memory", "permissionMode": "auto", "maxSteps": 200 }`.
- `/work` persists between turns: `/work/repo` (the clone, on `workBranch`) and
  `/work/.nyxs/session.json` (the saved conversation the next turn resumes from).
- Secrets arrive as env vars under their stored names (`<ID>_API_KEY`, which is also the name most
  vendors' own tools read, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`). Nyxs's job mode reads them as its
  keychain (`headless.rs` `secret_env_names`); Codex uses `OPENAI_API_KEY`, Claude Code
  `CLAUDE_CODE_OAUTH_TOKEN` or else `ANTHROPIC_API_KEY`.
- stdout: JSONL, one event per line, `{ "type", "data" }`, the same events `nyxs --headless
  --format json` prints, plus: `{ "type": "status", "data": { "status" } }` when it changes,
  `{ "type": "report", "data": { "text", "status" } }` for the thread's `report` tool, and a last
  `{ "type": "done", "data": { "status": "review" | "needs_input" | "failed", "preview",
  "prUrl"?, "branch"? } }`. Anything else the worker writes goes to stderr (logged, never shown).
- On success the worker commits, pushes `workBranch` with `GITHUB_TOKEN` and opens (or updates) a
  draft PR when the turn changed files; `prUrl` comes back in `done`.
- Exit code 0 when `done` was printed, non-zero otherwise (the runner then marks `failed`).

## Phase 3 — App ↔ cloud

- Settings › Nube: sign-in state, which credentials are synced (each provider opt-in, with a
  clear note that the key is stored encrypted on Nyxs servers), "Probar".
- A thread's "where" can be cloud; the coordinator's `start_thread` honours `where`. A cloud
  thread is a session whose messages come from the events API (polled while the app is open,
  caught up on launch). Replies from the user become `POST /messages`.
- Notifications on launch for cloud threads that finished or need input while the app was closed.

## Verification

- Unit tests for data, tools and API; an end-to-end check: create a project, ask for two tasks,
  see two threads, one local and one cloud; close the app; the cloud thread finishes and opens a
  branch/PR; reopening the app shows it under *Para revisar*.
