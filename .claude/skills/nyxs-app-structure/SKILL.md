---
name: nyxs-app-structure
description: How to add state to the Nyxs frontend without growing src/App.tsx, and how to keep splitting App.tsx and the other giant components (SettingsPanel, PreviewView, claude-style-chat-input). Use whenever adding a useState/useEffect/useMemo to App.tsx or another component over ~1000 lines, extracting a hook from one, or reviewing such a change.
---

# Keeping App.tsx (and the other giants) from growing

`src/App.tsx` held the state of the whole app: 3163 lines with 73 `useEffect` as of 2026-10-25.
It is being split into hooks by topic. **New state does not go into App.tsx.** Put it in a hook,
or in the component that uses it.

## Hooks already extracted

| Hook | What it owns |
| --- | --- |
| `src/lib/useChatViews.ts` | The side panel of each chat: open views, browser file/URL, live preview slots, reload restore. Also exports `withView`, `withoutView`, `toggledView`. |
| `src/lib/useModelContext.ts` | The context ring and its details, plan limits, session token use and cost, and effort levels of the model in use. |
| `src/lib/useMessageQueue.ts` | The queue of messages sent while a reply is running. |
| `src/lib/useSessionList.ts` | Saved and archived sessions for the sidebar, recent order, PR auto-archive, cleanup of old sessions. |
| `src/lib/useProviderModels.ts` | Saving settings and refreshing the model lists of Claude Code, the agent CLIs and API providers. |
| `src/lib/useRagAutoIndex.ts` | Re-indexing the folder for semantic search, never during a reply. |
| `src/lib/usePermissionPrompts.ts` | Permission rules, `gate`, pending approvals and agent questions, their notifications. |
| `src/lib/compactChat.ts` | `/compact` (not a hook: an async function with tests). |
| `src/components/TurnPrompts.tsx` | The banners above the chat box: compacting, plan ready, permission card, question. |
| `src/lib/useWorkspace.ts` | The open and recent folders, trusting them, project-settings trust, the NYXS.md offer. |
| `src/lib/builtinCommands.ts` | The built-in `/` commands, run against a `BuiltinContext` (with tests). |
| `src/lib/streamBuffer.ts`, `src/lib/chatMessages.ts` | Batching streamed text, and pure message transforms used by the turn (with tests). |
| `src/components/ChatTranscript.tsx` | The conversation: messages, queue, minimap, highlights, reply to a selection. |
| `src/lib/useChatScroll.ts` | Following new output, "show earlier", keeping the scroll place. |
| `src/lib/useAppShortcuts.ts` | Keyboard shortcuts (actions passed through a ref, see below). |
| `src/lib/useChatStore.ts` | The chats and the open one: loading, saving to disk, hydrating messages on demand, file history. |
| `src/lib/assistantTurn.ts` | `runAssistantTurn(turn, env)`: one reply from start to cleanup, against a `TurnEnv` (with tests). Also the reload-interrupted turn list. |
| `src/lib/sendMessage.ts` | `sendMessage(payload, displayText, env, chatId)`: what `handleSend` does (built-in and `/` commands, asking for a folder, new chat vs existing), against a `SendEnv` (with tests). `chatId` is where it goes, so the queue delivers to the chat it was queued in. Also `newChatId`. |
| `src/lib/chatWake.ts` | Waking a chat with no turn running: finished background shells (`wakeChatForShells`), Claude Code waking or reattaching after a reload (`wakeClaudeCodeChat`), API turns cut by a reload (`resumeInterruptedTurns`), against a `WakeEnv` (with tests). |
| `src/lib/sessionActions.ts` | The sidebar's and transcript's session actions against a `SessionActionsEnv` (with tests): archive with the uncommitted-files guard, unarchive, rewind a saved session, delete a chat or a session (nested ones too, or handed to the parent), each ending its turn and Claude Code process (`endChatAgent`), and fork the open chat. |
| `src/lib/useSessionWorktrees.ts` | Re-creating the open session's worktree on its branch, and removing archived sessions' worktrees after 30 days. |
| `src/lib/chatHistory.ts`, `src/lib/outgoingMessage.ts` | What the model receives of a chat, and turning the chat box's payload into a message (with tests). |
| `src/lib/usePromptSuggestion.ts` | The guessed next message after a reply. |
| `src/lib/prompts/appActions.ts` | The instructions the app's own buttons send (dev server, apply plan). |
| `src/lib/useStreamingChats.ts` | Which chats have a reply running, what each turn reports on the side (Claude Code compacting, retrying), and which chats Nyxs is summarising (`compactingIds`, per chat). |
| `src/lib/useProjectCommands.ts` | The folder's skills and `/` commands for the chat box, and its file list for `@`. |
| `src/lib/useChatModeAndModel.ts` | The picker's model and permission mode, following the open chat; `chatModeOf`; "skip permissions" falling back when settings stop allowing it. |
| `src/lib/useRewind.ts` | Rewinding a chat to a message (code, conversation or both) and the dialog's state. |
| `src/components/ChatPane.tsx` | One chat's transcript, banners and composer, with its own scroll (`useChatScroll`). Split view mounts two; the focused pane is always `activeId`, and the other swaps in its own model and state (`unfocusedInput`). |
| `src/lib/useSplitView.ts` | The two sessions of split view, reconciled during render with the open chat (with tests). |
| `src/lib/sessionState.ts` | `useSessionStates`: the sidebar's blocked/review/done badges. |

The composer under a chat (in `ChatPane`, via `paneInput`) and the one on the new-chat page share
their props through `chatInputProps`; add a prop there unless it really differs between them.
Objects passed to `ChatPane` (`paneTranscript`, `panePrompts`) must hold stable handlers: the
React Compiler treats functions inside an object prop as possibly called during render (see
`forkMessage`).

What is left in App.tsx (about 1270 lines) is coordination: building the `TurnEnv`, `SendEnv`,
`WakeEnv` and `SessionActionsEnv` objects when they are used, small actions (resend, rename,
start a chat with a prompt), and the JSX wiring of the sidebar, panels and dialogs. A new turn-related behaviour
goes in `assistantTurn.ts` (extend `TurnEnv` if it needs something from App) with a test, not in
App. Sending goes in `sendMessage.ts` and waking a chat in `chatWake.ts`, the same way. Pure
message logic goes in `chatMessages.ts`.

These modules are plain async functions run against an env, not hooks: App builds the env when
it calls them (`turnEnv()`, `sendEnv()`, `wakeEnv()`, `sessionActionsEnv()`), so it reads App's state at that moment and
the React Compiler never sees App's handlers passed during render.

## How to extract a hook

1. Pick a block whose names are used in few places outside it. List them first:
   `grep -n "\bname\b" src/App.tsx` for every state, ref and function in the block.
2. The hook takes what it reads from App as parameters (an options object when there are more
   than two) and returns only what App still uses. Keep the comments; they explain the why.
3. Move constants, types and pure helpers that only the block uses into the hook's module.
4. A function that callers keep in deps or refs should come out stable (`useCallback`). In
   App.tsx, `openView` used to be recreated every render and needed `openViewRef`; from the hook
   it is stable and the ref went away.
5. Remove the imports App no longer uses: tsc reports them as errors.

## React Compiler gotcha

ESLint runs the React Compiler rule `react-hooks/preserve-manual-memoization`. App.tsx is too big
for the compiler, so it never complained there, but a hook extracted from it is checked. When a
`useMemo`/`useCallback` depends on a value read from an object (`currentModel.apiModel`), and the
object is passed to a function *after* that memo, the compiler assumes it may be mutated and
fails with "This dependency may be modified later". Read the primitive fields you need right
after getting the object, before any memo (see the top of `useModelContext`).

A second one, specific to App: **don't pass App's handlers to a hook as a plain argument
during render** (`useX({ stop, newChat })`). The compiler then assumes the hook may call them
while rendering, follows them into the turn code, and reports every `Date.now()` and reassigned
local there as `react-hooks/purity` / `react-hooks/immutability` errors. Give the hook a ref
instead and fill it in an effect (`shortcutsRef` + `useAppShortcuts` is the model). Values and
stable setters are fine to pass.

## Checks after each step

- `node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit` (what CI runs; plain
  `npx tsc -p .` checks nothing)
- `npx eslint src`
- `npx vitest run`
- A look at the running app (`npm run tauri dev`). The built-in browser can't get past the login
  page on its own: the page gets Tauri's API, its permission check denies the calls, and the
  sign-in fallback that reads localStorage never runs.

If your checkout keeps a local backlog (`docs/mejoras-pendientes.md`, not in the repo), note
there what was extracted (section "Código y arquitectura").
