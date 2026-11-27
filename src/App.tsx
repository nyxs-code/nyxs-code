import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, type ChatSummary } from "@/components/Sidebar";
import { sectionLabel, type Section } from "@/lib/sections";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ManageModelsModal } from "@/components/ManageModelsModal";
import { DoctorModal } from "@/components/DoctorModal";
import { HelpModal } from "@/components/HelpModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { SessionSearchModal } from "@/components/SessionSearchModal";
import { type ChatMessage } from "@/components/Message";
import type { AttachedFile, PastedSnippet } from "@/components/ui/chat-input/types";
import { ViewsPanel, type ViewId } from "@/components/ViewsPanel";
import { GitBar } from "@/components/GitBar";
import { PlanLimitBar } from "@/components/PlanLimitBar";
import type { DiffFocus } from "@/components/DiffPanel";
import { prefetchChanges } from "@/components/diff/load";
import { loadSettings as loadDiffSettings } from "@/components/diff/settings";
import { diffModeFor } from "@/lib/gitBase";
import { usePanelVisual, type PanelVisual } from "@/lib/visualPanel";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";
import { ChangelogModal } from "@/components/ChangelogModal";
import { NEW_TERMINAL_EVENT } from "@/lib/terminalShortcut";
import { TooltipLayer } from "@/components/TooltipLayer";
import { TitleBar } from "@/components/TitleBar";
import { useAppNavigation, type AppNavSnapshot } from "@/lib/appNavigation";
import { ClaudeChatInput, type Model, type SendPayload } from "@/components/ui/claude-style-chat-input";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GlyphBackground } from "@/components/ui/backgrounds-glyph";
import { useAppearance, transcriptZoom, chatWidthClass } from "@/lib/appearance";
import { getActiveModels, getModel, getContextWindow, modelLogo, PROVIDERS } from "@/lib/models";
import { loadSettings, type Settings } from "@/lib/settings";
import { loadEffort, saveEffort, type EffortLevel } from "@/lib/effort";
import { loadWorkspace } from "@/lib/workspace";
import { useSettings } from "@/lib/useSettings";
import { requestSettingHighlight } from "@/lib/settingsHighlight";
import { useSessionStates } from "@/lib/sessionState";
import { runStartupAutoUpdate } from "@/lib/plugins";
import { type Chat } from "@/lib/chatStore";
import {
  claudeCodeSessionOf,
  onClaudeCodeWake,
  onClaudeCodeUnattendedPermission,
  reattachClaudeCodeRuns,
} from "@/lib/claudeCode";
import { clampTitle } from "@/lib/titles";
import { CornerNotices } from "@/components/CornerNotices";
import { RagConsentDialog } from "@/components/RagConsentDialog";
import { SshAskpassDialog } from "@/components/SshAskpassDialog";
import { TranscriptViewNotice } from "@/components/TranscriptViewNotice";
import { SideChatCard, SideChatPane, type SideChatInputBase } from "@/components/SideChat";
import { closeSideChat, openSideChatFor, setSideChatAvailable, setSideChatDocked, setSideChatFor, setSideChatHost, sideKey, toggleSideChat, useSideChat } from "@/lib/sideChat";
import { useSessionBridge } from "@/lib/useSessionBridge";
import { useSessionDirectoryHost } from "@/lib/sessionDirectory";
import { CliResumeDialog } from "@/components/CliResumeDialog";
import { chatFromCliSession, type CliMessage, type CliSessionSummary } from "@/lib/cliSessions";
import { type PickedElement } from "@/lib/pickedElement";
import { replyAttachTarget } from "@/lib/replyAttachTarget";
import { ChatPane, SessionDropZone } from "@/components/ChatPane";
import { useSplitView } from "@/lib/useSplitView";
import { setVideoAgentStopper } from "@/lib/video/videoControl";
import { useChatStore } from "@/lib/useChatStore";
import { usePromptSuggestion } from "@/lib/usePromptSuggestion";
import { outgoingMessage } from "@/lib/outgoingMessage";
import { runShortcutAction, useAppShortcuts, type AppShortcutActions } from "@/lib/useAppShortcuts";
import { adjacentSession } from "@/lib/sessionOrder";
import { setShownChats } from "@/lib/streamBuffer";
import { setNotifyContext } from "@/lib/notify";
import { OPEN_DIFF_EVENT } from "@/lib/diffComments";
import { createSessionWorktree, worktreeSupported } from "@/lib/worktree";
import { worktreeBaseOf } from "@/lib/worktreeBase";
import { usePublishFolderSessions } from "@/lib/folderSessions";
import { moveCommandsToBackground } from "@/lib/commandBackground";
import { useSessionWorktrees } from "@/lib/useSessionWorktrees";
import { setSessionEnvironments } from "@/lib/environments";
import { allowWorkspaceAccess } from "@/lib/workspace";
import { localizedError } from "@/lib/i18n";
import { SKILL_FROM_SESSION_PROMPT } from "@/lib/skillFromSession";
import { ThemeSound } from "@/components/ThemeSound";
import { setComposerAttach } from "@/lib/composerAttach";
import { forgetMinimized, minimizeView } from "@/lib/minimizedViews";
import { MinimizedViews } from "@/components/MinimizedViews";
import { TrustWorkspaceModal } from "@/components/TrustWorkspaceModal";
import { OpenProjectModal } from "@/components/OpenProjectModal";
import { ProjectOnboardingModal } from "@/components/ProjectOnboardingModal";
import { CustomizePanel } from "@/components/CustomizePanel";
import { BUILTIN_COMMANDS, BUILTIN_PROMPT_COMMANDS, parseBuiltinCommand, matchBuiltinPromptCommand, localizeCommandDescription, type SlashCommand } from "@/lib/slashCommand";
import { RoutinesPanel } from "@/components/RoutinesPanel";
import { createScheduler } from "@/lib/scheduler";
import { startRoutineDraft, type ScheduledTask } from "@/lib/scheduledTasks";
import type { PermissionMode } from "@/lib/configSchema";
import { matchCommand } from "@/lib/commands";
import { readSession, saveSession, renameSession } from "@/lib/sessionStorage";
import { markChatAsOnDisk, useSessionAutosave } from "@/lib/useSessionAutosave";
import { ArchivedSessionsModal } from "@/components/ArchivedSessionsModal";
import { clearSystemPromptCache } from "@/lib/systemPrompt";
import { BackgroundWaker, type FinishedShell } from "@/lib/backgroundWake";
import { RewindDialog } from "@/components/RewindDialog";
import { useConfirm } from "@/lib/useConfirm";
import { useStreamingChats } from "@/lib/useStreamingChats";
import { useProjectCommands } from "@/lib/useProjectCommands";
import { useRewind } from "@/lib/useRewind";
import { useChatModeAndModel } from "@/lib/useChatModeAndModel";
import { useReviewSync } from "@/lib/review/useReview";
import { useMessageQueue } from "@/lib/useMessageQueue";
import { toggleViewGuarded } from "@/lib/viewCloseGuard";
import { releasePreviews } from "@/lib/attachmentPreviews";
import { runBuiltinCommand } from "@/lib/builtinCommands";
import { chatViewsWorkspace, toggledView, useChatViews, withView, withoutView } from "@/lib/useChatViews";
import { useModelContext } from "@/lib/useModelContext";
import { useSessionList } from "@/lib/useSessionList";
import { lastSessionOf } from "@/lib/lastSession";
import { useLspFoldersInUse } from "@/lib/useLspFoldersInUse";
import { useWorkspace } from "@/lib/useWorkspace";
import { useProviderModels } from "@/lib/useProviderModels";
import { useRagAutoIndex } from "@/lib/useRagAutoIndex";
import { usePermissionPrompts } from "@/lib/usePermissionPrompts";
import { chatHistory } from "@/lib/chatHistory";
import { ADD_DEV_SERVER_PROMPT, applyPlanPrompt, START_DEV_SERVER_PROMPT } from "@/lib/prompts/appActions";
import { resendOf, textPayload, userMessageBefore } from "@/lib/chatMessages";
import { runAssistantTurn, type AssistantTurn, type TurnEnv } from "@/lib/assistantTurn";
import { newChatId, sendMessage, type SendEnv } from "@/lib/sendMessage";
import * as sessionActions from "@/lib/sessionActions";
import type { SessionActionsEnv } from "@/lib/sessionActions";
import { continueCutTurn, resumeInterruptedTurns, wakeChatForShells, wakeClaudeCodeChat, type WakeEnv } from "@/lib/chatWake";
import { goalTurnEnded, type GoalEnv } from "@/lib/goalMode";
import { GoalCard } from "@/components/goal/GoalCard";
import { draftModKey, matchModCommand, modKeyOf, useMods } from "@/lib/mods/useMods";
import { useComputerControlLayout } from "@/lib/useComputerControlLayout";
import { modHost } from "@/lib/mods/io";
import { ModBackdrop } from "@/components/mods/ModBackdrop";
import { ModBand } from "@/components/mods/ModBand";
import { ProjectsPage } from "@/components/projects/ProjectsPage";
import { ProjectFrame } from "@/components/projects/ProjectFrame";
import { useProjects, type ProjectAppActions } from "@/lib/projects/useProjects";
import { projectTurnEnded } from "@/lib/projects/projectHost";
import { isProjectHubDir } from "@/lib/projects/projectStore";

const uid = () => Math.random().toString(36).slice(2, 11);

export default function App() {
  const t = useTranslations();
  const appearance = useAppearance();
  const chatWidth = chatWidthClass(appearance.chatWidth);
  const tChat = t.chatInput;
  const tApp = t.app;
  const {
    chats,
    setChats,
    activeId,
    setActiveId,
    liveChatsRef,
    liveActiveIdRef,
    patchMessage,
    chatsReady,
    hydratedRef,
    ensureHydrated,
    fhRef,
    restorableMsgIds,
    fhUpdater,
    adoptFileHistory,
    withFileHistory,
  } = useChatStore();
  const [effort, setEffort] = useState<EffortLevel>(() => loadEffort());

  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [manageModelsOpen, setManageModelsOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  // The views panel maximized over the chat, which stays mounted but hidden.
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);

  const { streamingIds, streamingIdsRef, startStreaming, stopStreaming, turnSide, patchTurnSide, compactingIds, busyIds, setCompacting, startCompact, abortCompact } =
    useStreamingChats();
  const streaming = activeId != null && streamingIds.has(activeId);
  // Also while `/compact` runs outside a turn: the chat box shows Stop, Esc stops it, and new
  // messages wait in the queue for the compacted conversation.
  const busy = streaming || (activeId != null && compactingIds.has(activeId));
  const {
    workspace,
    recentWorkspaces,
    ensureWorkspaceActive,
    pickAndTrustWorkspace,
    closeWorkspace: closeRecentWorkspace,
    forgetWorkspace,
    pendingTrust,
    respondTrust,
    pendingOpenProject,
    confirmOpenProject,
    respondOpenProject,
    pendingOnboarding,
    createProjectMemory,
    dismissProjectOnboarding,
  } = useWorkspace(() => setActiveId(null));




  const fillInputRef = useRef<((value: string | SendPayload) => void) | null>(null);

  const attachElementRef = useRef<((el: PickedElement) => void) | null>(null);
  const attachFilesRef = useRef<((files: File[]) => void) | null>(null);
  const { currentViews, viewsOpen, openViews, previewSlots, patchViews, setViewsOpen, showPreviewOf, openView, claimDraftViews, dropChatViews } =
    useChatViews(activeId, chatViewsWorkspace(chats, activeId, workspace), (id) => chatViewsWorkspace(chats, id, workspace));

  const [diffNonce, setDiffNonce] = useState(0);
  const { pendingRewind, revertTo, confirmRewind, cancelRewind } = useRewind({
    activeId, chats, setChats, workspace, fhRef, fhUpdater, fillInputRef, setDiffNonce,
  });
  const [section, setSection] = useState<Section>("code");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const computerControlled = useComputerControlLayout(sidebarOpen, setSidebarOpen);
  // Runnable command blocks in the chat read this; kept stable so memoized messages don't
  // re-render each time App does.
  const commandRunEnv = useMemo(() => ({ workspace, openView: (v: string) => openView(v as ViewId) }), [workspace, openView]);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  const applyNav = useCallback((snap: AppNavSnapshot) => {
    setSection(snap.section);
    setSettingsOpen(snap.settingsOpen);
    setSettingsSection(snap.settingsSection);
  }, [setSection, setSettingsOpen, setSettingsSection]);
  const { canGoBack, canGoForward, navigate, goBack, goForward } = useAppNavigation(
    { settingsOpen: false, section: "code", settingsSection: undefined },
    applyNav,
  );
  const navSnapshot = useCallback(
    (patch: Partial<AppNavSnapshot>): AppNavSnapshot => ({
      settingsOpen,
      settingsSection,
      section,
      ...patch,
    }),
    [settingsOpen, settingsSection, section],
  );
  const closeSettings = useCallback(() => {
    navigate(navSnapshot({ settingsOpen: false, settingsSection: undefined }));
  }, [navigate, navSnapshot]);

  const effortRef = useRef(effort);
  useEffect(() => { effortRef.current = effort; }, [effort]);
  useEffect(() => saveEffort(effort), [effort]);

  const nyxsCfg = useSettings().settings as { allowPermissionBypass?: boolean; classifySessionStates?: boolean; promptSuggestions?: boolean; chat?: { splitView?: boolean } };
  const allowPermissionBypass = nyxsCfg.allowPermissionBypass ?? false;
  const classifyStates = nyxsCfg.classifySessionStates ?? false;
  const promptSuggestionsOn = nyxsCfg.promptSuggestions ?? true;
  const splitViewOn = nyxsCfg.chat?.splitView ?? true;

  const promptEnableBypass = useCallback(() => {
    navigate(navSnapshot({ settingsOpen: true, settingsSection: "code" }));
    requestSettingHighlight("permissionBypass");
  }, [navigate, navSnapshot]);
  const { selectedModel, permissionMode, modeRef, chatModeOf, handlePermissionModeChange, handleModelChange } =
    useChatModeAndModel({ activeId, liveChatsRef, liveActiveIdRef, setChats, allowPermissionBypass, promptEnableBypass });

  const {
    rules,
    deleteRule,
    clearRules,
    pending,
    pendingQuestion,
    gate,
    isAllowed,
    askUser,
    respondPermission,
    respondQuestion,
    cancelPrompts,
    clearPreapproval,
  } = usePermissionPrompts(activeId, chatModeOf, liveChatsRef);

  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const turnDoneRef = useRef<Map<string, Promise<void>>>(new Map());
  const handleSendRef = useRef<((payload: SendPayload, displayText?: string, chatId?: string | null) => Promise<void>) | null>(null);
  const wakeChatRef = useRef<((chatId: string, shells: FinishedShell[]) => Promise<void>) | null>(null);
  const goalEnvRef = useRef<() => GoalEnv>(() => { throw new Error("goal env not ready"); });
  const backgroundWakerRef = useRef<BackgroundWaker | null>(null);



  const { listProjectFiles, skillCommands, fileCommands, commandsRef } = useProjectCommands(workspace);

  const { sessions, sessionsLoaded, setSessions, orderedSessions, archivedSessions, archivedOpen, setArchivedOpen, refreshSessions, dropSessions, bumpRecent } =
    useSessionList(workspace, streamingIds.size === 0, (id) => id === liveActiveIdRef.current || streamingIdsRef.current.has(id));


  const customProviderName = t.settings.customProviderName;
  const modelOptions: Model[] = useMemo(
    () =>
      getActiveModels(settings).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        badge: m.badge,
        context: getContextWindow(m),
        ...modelLogo(m),
        provider: m.provider,
        providerName: m.provider === "custom" ? customProviderName : PROVIDERS[m.provider]?.name,
        providerLogo: PROVIDERS[m.provider]?.logo,
        providerLogoMono: PROVIDERS[m.provider]?.logoMono,
      })),
    [settings, customProviderName],
  );

  const effectiveModel = modelOptions.some((m) => m.id === selectedModel)
    ? selectedModel
    : modelOptions[0]?.id ?? "";

  const activeChat = chats.find((c) => c.id === activeId) ?? null;
  /** Where the open session works: its own worktree when it has one, else the project. */
  const workDir = activeChat?.worktree?.path ?? workspace;
  useSessionWorktrees({ activeChat, workspace, archivedSessions, setChats });
  usePublishFolderSessions(chats, sessions, busyIds, workspace);
  useLspFoldersInUse(workspace, chats, activeId, streamingIds);
  // Which saved environment each session's turns take their variables from.
  useEffect(() => { setSessionEnvironments(chats); }, [chats]);
  const chatIds = useMemo(() => new Set(chats.map((c) => c.id)), [chats]);
  const { split, openToSide, closePane } = useSplitView({ enabled: splitViewOn, activeId, setActiveId, chatIds });

  const { usesClaudeCode, contextShown, contextTotal, loadContextDetails, loadPlanUsage, cachedPlanUsage, sessionUsage, shownEffort, effortLevels, recommendedEffort } =
    useModelContext({
      model: effectiveModel,
      settings,
      workspace,
      // A session with an effort of its own (one an agent created) shows and changes that one.
      effort: activeChat?.effort ?? effort,
      messages: activeChat?.messages,
      contextUsed: activeChat?.contextTokens ?? 0,
      streaming,
    });

  useProviderModels(settings, setSettings);

  const reindexRag = useRagAutoIndex(workspace, streamingIds.size === 0);


  const shownSuggestion = usePromptSuggestion({
    activeId,
    streaming,
    enabled: promptSuggestionsOn,
    chats,
    settings,
    model: effectiveModel,
  });



  const blockedIds = [...pending.map((p) => p.chatId), ...(pendingQuestion ? [pendingQuestion.chatId] : [])];
  const sessionStates = useSessionStates(classifyStates, sessions, blockedIds, streamingIds);
  // Projects: a coordinator conversation with threads (src/lib/projects). App's actions reach it
  // through a ref filled below.
  const projectAppRef = useRef<ProjectAppActions | null>(null);
  const projectsApi = useProjects({ chats, setChats, liveChatsRef, hydratedRef, ensureHydrated, patchMessage, sessions, streamingIds, blockedIds, effectiveModel, settings, appRef: projectAppRef });

  useSessionAutosave({ ready: chatsReady, workspace, activeChat, restorableMsgIds, withFileHistory, onSaved: refreshSessions });

  const resumeSession = useCallback(
    async (sessionId: string, sessionWorkspace?: string | null) => {
      setSection("code");

      const target = sessionWorkspace ?? loadWorkspace();
      if (target && target !== loadWorkspace()) {
        if (!(await ensureWorkspaceActive(target))) return;
      }

      if (liveChatsRef.current.some((c) => c.id === sessionId)) {
        setActiveId(sessionId);
        return;
      }
      const loaded = await readSession(target, sessionId);
      if (!loaded) return;

      const chat: Chat = { ...loaded, workspace: target };
      markChatAsOnDisk(chat);

      if (chat.fileHistory) adoptFileHistory(chat.id, chat.fileHistory);
      hydratedRef.current.add(chat.id);
      setChats((prev) => (prev.some((c) => c.id === chat.id) ? prev : [chat, ...prev]));
      setActiveId(chat.id);
    },
    [ensureWorkspaceActive, adoptFileHistory, hydratedRef, liveChatsRef, setActiveId, setChats],
  );

  const [confirm, confirmElement] = useConfirm();

  /** What "Continue last session" opens: the open folder's latest, not another project's. */
  const lastHere = workspace ? lastSessionOf(sessions, workspace) : undefined;

  /** Where a chat's turns work: its worktree, else the open project. */
  const workDirOfChat = (id: string) => chats.find((c) => c.id === id)?.worktree?.path ?? workspace;

  /** The worktree a new session starts in when the composer's switch is on. Undefined: no
   *  worktree (not a git project, or the user goes on without one after it failed). Null: the
   *  user gave up sending. */
  const startSessionWorktree = async (ws: string | null, id: string) => {
    if (!ws || !(await worktreeSupported(ws))) return undefined;
    try {
      const wt = await createSessionWorktree(ws, id, undefined, worktreeBaseOf(ws));
      await allowWorkspaceAccess(wt.path);
      return wt;
    } catch (e) {
      const goOn = await confirm({
        title: t.worktree.failedTitle,
        message: t.worktree.failedBody.replace("{error}", localizedError(e)),
        confirmLabel: t.worktree.continueWithout,
        cancelLabel: t.modals.cancel,
      });
      return goOn ? undefined : null;
    }
  };

  // What the session actions (archive, rewind, delete, fork) read and change; built when one runs.
  const sessionActionsEnv = (): SessionActionsEnv => ({
    t,
    workspace,
    // Archived ones too: they can be deleted from Recents and still need their own folder.
    sessions: [...sessions, ...archivedSessions],
    chats,
    liveChats: () => liveChatsRef.current,
    activeId,
    liveFileHistory: (id) => fhRef.current.get(id),
    confirm,
    setChats,
    setActiveId,
    refreshSessions,
    dropSessions,
    hydrated: hydratedRef.current,
    dropChatViews,
    streaming: (id) => streamingIdsRef.current.has(id),
    abortTurn,
  });
  const uncommittedFilesOf = (id: string) => sessionActions.uncommittedFilesOf(id, sessionActionsEnv());

  useEffect(() => {
    void runStartupAutoUpdate();
  }, []);

  const chooseWorkspace = () => { void pickAndTrustWorkspace(); };

  /** The views menu and its shortcuts: closing a view (Files with an unsaved file) asks as its X does. */
  // The side chat has a conversation to forget on close and a minimized card besides the view.
  const toggleViewOf = (v: ViewId) => {
    // The panel belongs to the session (see panelShown): from a full page (Plugins, Routines…)
    // a view's button goes back to the session with that view open, instead of closing it
    // unseen.
    if (section !== "code") {
      navigate(navSnapshot({ section: "code", settingsOpen: false, settingsSection: undefined }));
      if (openViews.includes(v)) return;
      if (v === "sidechat") toggleSideChat();
      else patchViews((cur) => withView(cur, v));
      return;
    }
    if (v === "sidechat") toggleSideChat();
    else toggleViewGuarded(v, openViews.includes(v), () => patchViews((cur) => toggledView(cur, v)));
  };
  // The views panel (browser, previews, terminal…) shows beside a session only. Hidden, not
  // closed: back in the session its pages and terminals are as they were.
  const panelShown = viewsOpen && !computerControlled && section === "code";

  // Each session's side chat: a view of its own panel, so switching sessions hides it with the
  // rest of the panel; its minimized card shows only for the session on screen.
  useEffect(() => { setSideChatFor(activeId); }, [activeId]);
  useEffect(() => {
    setSideChatHost({
      dock: () => patchViews((cur) => withView(cur, "sidechat")),
      undock: () => patchViews((cur) => withoutView(cur, "sidechat")),
    });
    return () => setSideChatHost(null);
  }, [patchViews]);
  const sideDocked = openViews.includes("sidechat");
  // A minimized panel opened again, from its card or its title-bar button: its card goes.
  useEffect(() => {
    if (openViews.includes("preview")) forgetMinimized("preview");
    if (openViews.includes("terminal")) forgetMinimized("terminal");
  }, [openViews]);
  useEffect(() => { setSideChatDocked(sideDocked); }, [sideDocked]);
  const sideFloating = useSideChat().sessions[sideKey(activeId)]?.floating ?? false;
  // Only for a session with messages: there's nothing to ask about before, and a new session
  // only gets its id with its first message.
  const sideAvailable = (activeChat?.messages.length ?? 0) > 0;
  useEffect(() => {
    setSideChatAvailable(sideAvailable);
    // Emptied by /clear while open.
    if (!sideAvailable && (sideDocked || sideFloating)) closeSideChat();
  }, [sideAvailable, sideDocked, sideFloating]);

  const selectWorkspace = useCallback(async (path: string) => {
    if (path === workspace) return;
    if (await ensureWorkspaceActive(path)) setActiveId(null);
  }, [workspace, ensureWorkspaceActive, setActiveId]);

  const closeWorkspace = useCallback((path: string) => {
    // Closing another folder only changes which sessions the sidebar lists.
    if (!closeRecentWorkspace(path)) refreshSessions();
  }, [closeRecentWorkspace, refreshSessions]);

  useEffect(() => {
    if (activeId) void ensureHydrated(activeId);
  }, [activeId, ensureHydrated]);

  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const summaries: ChatSummary[] = chats
    // Only in-memory chats belonging to the active workspace (a chat tagged with
    // another folder must not show here), and not already saved as a session.
    .filter((c) => (c.workspace ?? null) === (workspace ?? null) && !sessionIds.has(c.id))
    .map((c) => ({ id: c.id, title: c.title }));

  const newChat = () => {
    clearSystemPromptCache();
    setActiveId(null);
    setSection("code");
  };

  const deleteChat = (id: string) => sessionActions.deleteChat(id, sessionActionsEnv());

  const startChatWithPrompt = useCallback((
    title: string,
    prompt: string,
    // A scheduled task can pick its own model and permission mode.
    opts: { model?: string; permissionMode?: PermissionMode } = {},
  ) => {
    const id = newChatId(chats);
    const model = opts.model && modelOptions.some((m) => m.id === opts.model) ? opts.model : effectiveModel;
    const chat: Chat = { id, title, workspace, messages: [], model, permissionMode: opts.permissionMode ?? modeRef.current };
    hydratedRef.current.add(id);
    setChats((prev) => [chat, ...prev]);
    setActiveId(id);
    setSection("code");
    // To this chat by id: the open one may have changed by the time it is sent.
    setTimeout(
      () => handleSendRef.current?.({ message: prompt, files: [], pastedContent: [], model, isThinkingEnabled: false }, undefined, id),
      0,
    );
  }, [chats, workspace, effectiveModel, modelOptions, hydratedRef, modeRef, setChats, setActiveId]);

  /** /resume: a Claude Code CLI session continues here as a saved chat of the project. */
  const importCliSession = (session: CliSessionSummary, messages: CliMessage[]) => {
    if (!workspace) return;
    const chat = chatFromCliSession({
      chatId: newChatId(chats),
      workspace,
      session,
      messages,
      model: effectiveModel.startsWith("claude-code:") ? effectiveModel : "claude-code:opus",
      permissionMode: modeRef.current,
    });
    hydratedRef.current.add(chat.id);
    setChats((prev) => [chat, ...prev]);
    setActiveId(chat.id);
    setSection("code");
    void saveSession(workspace, chat, Date.now()).then(refreshSessions);
  };

  // A routine made from a session runs in that session's project: the project opens first, and
  // the routine starts once it is the open one (the chat and its turn take the open folder).
  const pendingRoutineRef = useRef<ScheduledTask | null>(null);
  const runRoutine = useCallback(
    (task: ScheduledTask) => {
      if (!task.workspace || task.workspace === workspace) {
        startChatWithPrompt(task.name || "Routine", task.prompt, { model: task.model, permissionMode: task.permissionMode });
        return;
      }
      pendingRoutineRef.current = task;
      void ensureWorkspaceActive(task.workspace).then((ok) => {
        if (!ok && pendingRoutineRef.current === task) pendingRoutineRef.current = null;
      });
    },
    [startChatWithPrompt, workspace, ensureWorkspaceActive],
  );
  useEffect(() => {
    const task = pendingRoutineRef.current;
    if (!task || task.workspace !== workspace) return;
    pendingRoutineRef.current = null;
    startChatWithPrompt(task.name || "Routine", task.prompt, { model: task.model, permissionMode: task.permissionMode });
  }, [workspace, startChatWithPrompt]);

  const startChatRef = useRef(startChatWithPrompt);
  useEffect(() => { startChatRef.current = startChatWithPrompt; });
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const off = listen<string>("quick:prompt", (e) => {
      const prompt = e.payload.trim();
      if (prompt) startChatRef.current(clampTitle(prompt), prompt);
    });
    return () => { void off.then((fn) => fn()); };
  }, []);

  // A clicked notification opens its session, Settings closed (see agent/notify.rs).
  const openFromNotificationRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    openFromNotificationRef.current = (id) => {
      navigate(navSnapshot({ section: "code", settingsOpen: false, settingsSection: undefined }));
      void resumeSession(id, sessions.find((s) => s.id === id)?.workspace);
    };
  });
  // The chat's session cards (a session an agent created, a message from another) read this.
  const sessionDirectory = useMemo(() => {
    const saved = new Set(sessions.map((s) => s.id));
    return [
      ...sessions.map((s) => ({ id: s.id, title: s.title, parentId: s.parentId, working: streamingIds.has(s.id) })),
      ...chats.filter((c) => !saved.has(c.id)).map((c) => ({ id: c.id, title: c.title, parentId: c.parentId, working: streamingIds.has(c.id) })),
    ];
  }, [sessions, chats, streamingIds]);
  useSessionDirectoryHost(sessionDirectory, (id) => openFromNotificationRef.current(id));
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const off = listen<string>("notification-open", (e) => {
      if (e.payload) openFromNotificationRef.current(e.payload);
    });
    return () => { void off.then((fn) => fn()); };
  }, []);

  const runRoutineRef = useRef(runRoutine);
  useEffect(() => { runRoutineRef.current = runRoutine; });
  useEffect(() => {
    const sched = createScheduler((task) => runRoutineRef.current?.(task));
    sched.start();
    return () => sched.stop();
  }, []);

  const renameChat = (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: t } : c)));
  };

  const renameSavedSession = async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    const ws = sessions.find((s) => s.id === id)?.workspace ?? workspace;
    await renameSession(ws, id, t);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: t } : s)));
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: t } : c)));
  };

  const hasMessages = (activeChat?.messages.length ?? 0) > 0;
  const appCommands = useMemo<SlashCommand[]>(() => {
    const sc = t.slashCommands as unknown as Record<string, string>;
    const loc = (name: string, fallback: string) => localizeCommandDescription(name, sc, fallback);
    const builtins: SlashCommand[] = BUILTIN_COMMANDS
      // The side chat reads the session's messages: not offered before there are any.
      .filter((c) => c.name !== "btw" || hasMessages)
      .map((c) => ({ ...c, description: loc(c.name, c.description) }));
    const promptCmds: SlashCommand[] = BUILTIN_PROMPT_COMMANDS.map((c) => ({ name: c.name, description: loc(c.name, c.description) }));
    const skillCmds: SlashCommand[] = skillCommands.map((c) => ({ name: c.name, description: loc(c.name, c.description) }));
    const taken = new Set([...builtins, ...promptCmds, ...skillCmds].map((c) => c.name.toLowerCase()));
    const fileCmds = fileCommands
      .filter((c) => !taken.has(c.name.toLowerCase()))
      .map((c) => ({ name: c.name, description: c.description }));
    // A skill named like a built-in (a project's own `commit`) is listed once: as the one that runs,
    // which is the first here, since sending checks them in this order.
    const seen = new Set<string>();
    return [...builtins, ...promptCmds, ...skillCmds, ...fileCmds].filter((c) => {
      const name = c.name.toLowerCase();
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }, [skillCommands, fileCommands, t, hasMessages]);
  const appCommandNames = useMemo(() => [...BUILTIN_COMMANDS.map((c) => c.name), ...appCommands.map((c) => c.name)], [appCommands]);
  const { modKey, modCommands } = useMods({ activeId, workspace, chats, reservedCommands: appCommandNames, themed: section === "code" });
  const allCommands = useMemo<SlashCommand[]>(() => [...appCommands, ...modCommands], [appCommands, modCommands]);

  /** A message from Nyxs in `chatId`, or in a new chat when there is none. */
  const appendLocalAssistant = (content: string, chatId: string | null) => {
    let id = chatId;
    if (!id) {
      id = newChatId(chats);
      const chat: Chat = { id, title: "Comandos", workspace, messages: [], model: effectiveModel, permissionMode: modeRef.current };
      hydratedRef.current.add(id);
      setChats((prev) => [chat, ...prev]);
      claimDraftViews(id);
      setActiveId(id);
    }
    const msg: ChatMessage = { id: uid(), role: "assistant", content, createdAt: Date.now() };
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, messages: [...c.messages, msg] } : c)));
  };

  // Runs against the chat that issued the command, which may no longer be the open one when
  // the command waited in that chat's queue.
  const runBuiltin = (name: string, args: string, chatId: string | null): Promise<void> =>
    runBuiltinCommand(name, args, {
      chat: chatId ? liveChatsRef.current.find((c) => c.id === chatId) : undefined,
      modelId: effectiveModel,
      selectedModelId: effectiveModel,
      settings,
      workspace,
      permissionMode,
      allowPermissionBypass,
      effort,
      startCompact,
      reply: (content) => appendLocalAssistant(content, chatId),
      send: (payload, displayText) => void handleSendRef.current?.(payload, displayText, chatId),
      patchChat: (chatId, patch) => setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, ...patch } : c))),
      setCompacting,
      newChat,
      openDialog: (dialog) =>
        ({ help: setHelpOpen, shortcuts: setShortcutsOpen, models: setManageModelsOpen, doctor: setDoctorOpen })[dialog](true),
      openSettings: (settingsSection) => navigate(navSnapshot({ settingsOpen: true, settingsSection })),
      openView,
      setPermissionMode: handlePermissionModeChange,
      promptEnableBypass,
    });

  const abortTurn = (chatId: string) => {
    abortControllers.current.get(chatId)?.abort();
    abortCompact(chatId);
    stopStreaming(chatId);
    setCompacting(chatId, false);
    cancelPrompts(chatId);
  };
  useEffect(() => setVideoAgentStopper(abortTurn));

  const queue = useMessageQueue<SendPayload>({
    activeId,
    busyIds,
    send: async (item, chatId) => {
      queuedUserMsgs.current.delete(item.id);
      await turnDoneRef.current.get(chatId);
      // To the chat it was queued in, even if the user opened another one meanwhile.
      return handleSendRef.current?.(item.payload, item.displayText, chatId);
    },
    abort: abortTurn,
    release: (item) => releasePreviews(item.payload.files),
    prepare: async (item) => {
      const p = item.payload;
      const text = p.message.trim();
      if (item.displayText || parseBuiltinCommand(text) || matchBuiltinPromptCommand(text) || matchCommand(text, commandsRef.current) || matchModCommand(text, modKey)) return null;
      const out = await outgoingMessage(p);
      if (!out) return null;
      queuedUserMsgs.current.set(item.id, out.userMessage);
      return { id: item.id, text: out.modelText, images: out.modelImages };
    },
  });
  const queuedUserMsgs = useRef(new Map<string, ChatMessage>());
  const queuedAsMessages = (items: { id: string }[]): ChatMessage[] => {
    const now = Date.now();
    return items.flatMap((it) => {
      const m = queuedUserMsgs.current.get(it.id);
      queuedUserMsgs.current.delete(it.id);
      return m ? [{ ...m, createdAt: now }] : [];
    });
  };

  useReviewSync(activeId, workspace);

  const [diffFocus, setDiffFocus] = useState<DiffFocus | null>(null);
  /** Opens the changes view, at a file when one is given. */
  const openReview = (path?: string) => {
    if (path) setDiffFocus((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
    openView("diff");
  };
  // A review card's "Show in diff" and "Walk through in diff".
  const openReviewRef = useRef(openReview);
  useEffect(() => { openReviewRef.current = openReview; });
  useEffect(() => {
    const onOpen = (e: Event) => openReviewRef.current((e as CustomEvent<string | undefined>).detail);
    window.addEventListener(OPEN_DIFF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIFF_EVENT, onOpen);
  }, []);

  const sendGitCommand = (command: "/create-pr") =>
    void handleSendRef.current?.({ message: command, files: [], pastedContent: [], model: effectiveModel, isThinkingEnabled: false });

  const gitBarOf = (dir: string | null, busy: boolean, session?: { id: string; workspace: string | null }) => (
    <GitBar
      key={`${dir ?? ""}\n${session?.id ?? ""}`}
      workspace={dir}
      sessionId={session?.id}
      sessionWorkspace={session?.workspace}
      refreshKey={diffNonce}
      disabled={busy}
      onOpenChanges={() => openReview()}
      onCreatePr={() => sendGitCommand("/create-pr")}
    />
  );
  const planBar = usesClaudeCode ? <PlanLimitBar /> : null;

  // A visual moved to the side panel ("Show in another panel") gets its own view there.
  const panelVisual = usePanelVisual();
  const prevPanelVisual = useRef<PanelVisual | null>(null);
  useEffect(() => {
    const was = prevPanelVisual.current;
    prevPanelVisual.current = panelVisual;
    if (panelVisual) patchViews((cur) => withView(cur, "visual"));
    else if (was) patchViews((cur) => (cur.views.includes("visual") ? withoutView(cur, "visual") : {}));
  }, [panelVisual, patchViews]);

  // `sendPrompt(text)` from a visual: sent like a message the user typed.
  const sendVisualPromptRef = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    sendVisualPromptRef.current = (text) => {
      const payload = { message: text, files: [], pastedContent: [], model: effectiveModel, isThinkingEnabled: false };
      if (busy) queue.enqueue(payload);
      else void handleSendRef.current?.(payload);
    };
  });
  useEffect(() => {
    const onPrompt = (e: Event) => sendVisualPromptRef.current((e as CustomEvent<string>).detail);
    window.addEventListener(VISUAL_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(VISUAL_PROMPT_EVENT, onPrompt);
  }, []);

  useEffect(() => {
    const waker = new BackgroundWaker({
      isTurnRunning: (chatId) => abortControllers.current.has(chatId),
      readTail: async (shellId) =>
        (await invoke<{ output: string }>("agent_bg_output", { id: shellId, after: 0, waitMs: 0 })).output,
      wake: (chatId, shells) => void wakeChatRef.current?.(chatId, shells),
    });
    backgroundWakerRef.current = waker;
    const unlisten = listen<{ id: string; status: string; code: number | null }>("bg-shell-exit", (e) => {
      void waker.exited(e.payload.id, e.payload.status, e.payload.code);
    });
    // A monitor's new lines wake its chat's agent (the Monitor tool).
    const unlistenOutput = listen<{ id: string; line: string }>("bg-shell-output", (e) => waker.output(e.payload.id, e.payload.line));
    return () => {
      void unlisten.then((f) => f());
      void unlistenOutput.then((f) => f());
      if (backgroundWakerRef.current === waker) backgroundWakerRef.current = null;
    };
  }, []);

  // What a turn reads and changes in the app; built when the turn starts.
  const turnEnv = (): TurnEnv => ({
    settings,
    permissionMode: () => modeRef.current,
    effort: () => effortRef.current,
    setChats,
    patchMessage,
    liveChat: (chatId) => liveChatsRef.current.find((c) => c.id === chatId),
    abortControllers: abortControllers.current,
    turnsDone: turnDoneRef.current,
    startStreaming,
    stopStreaming,
    patchTurnSide,
    setCompacting,
    bumpRecent,
    gate,
    askUser,
    clearPreapproval,
    cancelPrompts,
    fileHistory: fhUpdater,
    queue,
    queuedAsMessages,
    showPreview: showPreviewOf,
    filesChanged: () => setDiffNonce((n) => n + 1),
    backgroundShell: (chatId, event) => backgroundWakerRef.current?.onEvent(chatId, event),
    turnEnded: (chatId, outcome) => {
      backgroundWakerRef.current?.turnEnded(chatId);
      // A project's thread that ended without reporting is ready for review.
      projectTurnEnded(chatId, outcome);
      // A goal set with /goal: checked, and another turn while it isn't met.
      void goalTurnEnded(chatId, outcome, goalEnvRef.current());
      // The session's mods hear the reply, and the ones the agent wrote load now.
      const last = liveChatsRef.current.find((c) => c.id === chatId)?.messages.at(-1);
      void (async () => {
        if (last?.role === "assistant" && typeof last.content === "string") await modHost.responded(chatId, last.content);
        await modHost.turnEnded(chatId);
      })();
    },
    reindexRag,
    openProviderSettings: () => navigate(navSnapshot({ settingsOpen: true, settingsSection: "providers" })),
  });
  const streamAssistantTurn = (turn: AssistantTurn) => runAssistantTurn(turn, turnEnv());

  const buildChatHistory = async (chatId: string) => {
    const msgs = await ensureHydrated(chatId);
    const current = liveChatsRef.current.find((c) => c.id === chatId);
    const built = chatHistory(msgs, current?.summary, current?.compactedUpTo);
    if (built.summaryDropped) {
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, summary: "", compactedUpTo: 0 } : c)));
    }
    return built;
  };

  // What waking a chat (finished background shells, Claude Code, a reload) reads; built then.
  const wakeEnv = (): WakeEnv => ({
    settings,
    effectiveModel,
    workspace,
    liveChats: () => liveChatsRef.current,
    turnRunning: (chatId) => abortControllers.current.has(chatId),
    streaming: (chatId) => streamingIdsRef.current.has(chatId),
    ensureHydrated,
    setChats,
    buildChatHistory,
    streamTurn: streamAssistantTurn,
  });
  useEffect(() => { wakeChatRef.current = (chatId, shells) => wakeChatForShells(chatId, shells, wakeEnv()); });
  useEffect(() => {
    goalEnvRef.current = () => ({
      ...wakeEnv(),
      liveChat: (chatId) => liveChatsRef.current.find((c) => c.id === chatId),
      queued: (chatId) => queue.hasQueued(chatId),
    });
  });

  useSessionBridge({
    streamAssistantTurn,
    chats,
    sessions,
    setChats,
    abortControllers,
    turnsDone: turnDoneRef,
    hydratedRef,
    refreshSessions,
    workspace,
    settings,
    effectiveModel,
    effort: () => effortRef.current,
    buildChatHistory,
    liveChatsRef,
  });

  const resumeInterruptedRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { resumeInterruptedRef.current = () => resumeInterruptedTurns(wakeEnv()); });

  // What sending a message reads and changes in the app; built when it's sent.
  const sendEnv = (): SendEnv => ({
    activeId,
    workspace,
    settings,
    chats,
    effectiveModel,
    permissionMode: () => modeRef.current,
    fileCommands: () => commandsRef.current,
    runBuiltin,
    runModCommand: async (text, chatId) => {
      const key = modKeyOf(chatId, workspace);
      const cmd = matchModCommand(text, key);
      if (!cmd) return false;
      // Its answer is a toast: no session is made for it and nothing goes in the chat.
      await modHost.runCommand(key, cmd.name, cmd.args);
      return true;
    },
    modPrompt: (text, chatId) => modHost.submitPrompt(modKeyOf(chatId, workspace), text),
    modNotice: (chatId) => modHost.takeNotice(chatId),
    chatCreated: (chatId) => modHost.adopt(draftModKey(workspace), chatId),
    resend: (payload, displayText, chatId) => handleSendRef.current?.(payload, displayText, chatId),
    askForWorkspace: async () => ((await confirmOpenProject()) ? pickAndTrustWorkspace() : null),
    refillInput: (payload) => fillInputRef.current?.(payload),
    openProviderSettings: () => navigate(navSnapshot({ settingsOpen: true, settingsSection: "providers" })),
    startSessionWorktree,
    buildChatHistory,
    workDirOfChat,
    setChats,
    openNewChat: (chat) => {
      hydratedRef.current.add(chat.id);
      setChats((prev) => [chat, ...prev]);
      claimDraftViews(chat.id);
      setActiveId(chat.id);
    },
    refreshSessions,
    streamTurn: streamAssistantTurn,
  });
  /** `chatId`: where the message goes (default: the open chat). */
  const handleSend = (payload: SendPayload, displayText?: string, chatId?: string | null): Promise<void> =>
    sendMessage(payload, displayText, sendEnv(), chatId);
  useEffect(() => { handleSendRef.current = handleSend; });

  const wakeRef = useRef<(sessionId: string, opts: { chatKey?: string; resumed: boolean }) => boolean>(() => false);
  useEffect(() => { wakeRef.current = (sessionId, opts) => wakeClaudeCodeChat(sessionId, opts, wakeEnv()); });
  useEffect(() => onClaudeCodeWake((sessionId, opts) => wakeRef.current(sessionId, opts)), []);
  useEffect(() => {
    if (!chatsReady) return;
    void reattachClaudeCodeRuns();
    void resumeInterruptedRef.current();
  }, [chatsReady]);
  useEffect(
    () =>
      onClaudeCodeUnattendedPermission(async (sessionId, toolName, input) => {
        const chat = liveChatsRef.current.find(
          (c) => claudeCodeSessionOf(c.messages.map((m) => m.responseMessages)) === sessionId,
        );
        return isAllowed(chat?.id, toolName, input);
      }),
    [isAllowed, liveChatsRef],
  );

  const stop = () => {
    if (!activeId) return;
    abortTurn(activeId);
    queue.pause(activeId);
  };

  useEffect(() => {
    projectAppRef.current = {
      send: async (payload, displayText, chatId) => { await handleSendRef.current?.(payload, displayText, chatId); },
      openSession: (id, ws) => {
        navigate(navSnapshot({ section: "code", settingsOpen: false, settingsSection: undefined }));
        void resumeSession(id, ws);
      },
      abortTurn,
      dropSessions: (ids) => dropSessions(ids, "", undefined),
      refreshSessions,
    };
  });

  // Notifications skip the session on screen and are titled with the session's name.
  useEffect(() => {
    setNotifyContext(activeId, (id) => sessions.find((s) => s.id === id)?.title ?? summaries.find((c) => c.id === id)?.title);
  });

  const shortcutsRef = useRef<AppShortcutActions | null>(null);
  useAppShortcuts(shortcutsRef);
  useEffect(() => {
    shortcutsRef.current = {
      streaming: busy,
      stop,
      newChat,
      toggleSettings: () => navigate(navSnapshot({ settingsOpen: !settingsOpen, settingsSection: undefined })),
      toggleShortcuts: () => setShortcutsOpen((o) => !o),
      openFind: () => setFindOpen(true),
      toggleSessionSearch: () => setSessionSearchOpen((o) => !o),
      toggleSidebar: () => setSidebarOpen((o) => !o),
      closeViews: () => setViewsOpen(false),
      toggleView: toggleViewOf,
      openNewTerminal: () => {
        patchViews((cur) => withView(cur, "terminal"));
        window.dispatchEvent(new Event(NEW_TERMINAL_EVENT));
      },
      goBack,
      goForward,
      cycleSession: (step) => {
        const id = adjacentSession(activeId, step, orderedSessions.map((s) => s.id));
        if (id) void resumeSession(id, sessions.find((s) => s.id === id)?.workspace);
      },
      moveToBackground: () => moveCommandsToBackground(activeId ?? undefined),
    };
  });

  const steer = (payload: SendPayload, displayText?: string) => {
    if (!busy || !activeId) {
      void handleSend(payload, displayText);
      return;
    }
    queue.steer(payload, displayText);
  };

  const sendAction = ([message, shown]: readonly [string, string], model = effectiveModel) =>
    void handleSend(textPayload(message, model), shown);
  const requestAddServer = () => { if (!streaming) sendAction(ADD_DEV_SERVER_PROMPT); };
  const requestDevServer = () => { if (!streaming) sendAction(START_DEV_SERVER_PROMPT); };

  const pickElementContext = (element: PickedElement) => {
    const reply = replyAttachTarget();
    if (reply) reply.element(element);
    else attachElementRef.current?.(element);
  };

  const attachPreviewImage = (file: File) => {
    const reply = replyAttachTarget();
    if (reply) reply.files([file]);
    else attachFilesRef.current?.([file]);
  };
  // The image viewer's "Add to message" (an annotated picture) lands where a page's screenshot does.
  const attachPreviewImageRef = useRef(attachPreviewImage);
  useEffect(() => { attachPreviewImageRef.current = attachPreviewImage; });
  useEffect(() => {
    setComposerAttach((files) => files.forEach((f) => attachPreviewImageRef.current(f)));
    return () => setComposerAttach(null);
  }, []);

  const applyPlan = () => {
    handlePermissionModeChange("acceptEdits");
    modeRef.current = "acceptEdits";
    sendAction(applyPlanPrompt(activeChat?.plan), effectiveModel);
  };

  const resendFrom = (userMessageId: string, text?: string) => {
    if (!activeId || streaming) return;
    const chatId = activeId;
    const chat = liveChatsRef.current.find((c) => c.id === chatId);
    const resend = chat && resendOf(chat.messages, userMessageId, text, effectiveModel);
    if (!resend) return;
    liveChatsRef.current = liveChatsRef.current.map((c) => (c.id === chatId ? { ...c, messages: resend.messages } : c));
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, messages: resend.messages } : c)));
    setTimeout(() => handleSendRef.current?.(resend.payload), 0);
  };
  const resendFromRef = useRef(resendFrom);
  useEffect(() => { resendFromRef.current = resendFrom; });
  const retryAssistant = useCallback((assistantId: string) => {
    const chat = liveChatsRef.current.find((c) => c.id === liveActiveIdRef.current);
    const asked = chat && userMessageBefore(chat.messages, assistantId);
    if (asked) resendFromRef.current(asked.id);
  }, [liveActiveIdRef, liveChatsRef]);
  const editUserMessage = useCallback((userId: string, text: string) => {
    resendFromRef.current(userId, text);
  }, []);

  const forkFrom = (messageId: string) => sessionActions.forkOpenChat(messageId, sessionActionsEnv());
  // Stable, like retryAssistant: the panes get it inside an object prop, which the React Compiler
  // would otherwise follow into the Date.now above as if it ran during render.
  const forkFromRef = useRef(forkFrom);
  useEffect(() => { forkFromRef.current = forkFrom; });
  const forkMessage = useCallback((messageId: string) => forkFromRef.current(messageId), []);

  // The chat box under a chat and the one on the new-chat page differ only in a few props.
  const chatInputProps = {
    widthClass: chatWidth,
    models: modelOptions,
    selectedModel: effectiveModel,
    onModelChange: handleModelChange,
    onSendMessage: handleSend,
    onOpenSettings: () => navigate(navSnapshot({ settingsOpen: true, settingsSection: undefined })),
    onManageModels: () => setManageModelsOpen(true),
    isStreaming: busy,
    onStop: stop,
    contextUsed: contextShown,
    contextTotal: contextTotal,
    onLoadContextDetails: loadContextDetails,
    onLoadPlanUsage: loadPlanUsage,
    cachedPlanUsage: cachedPlanUsage,
    sessionUsage: sessionUsage,
    permissionMode: permissionMode,
    onPermissionModeChange: handlePermissionModeChange,
    allowPermissionBypass: allowPermissionBypass,
    effort: shownEffort,
    onEffortChange: (level: EffortLevel) => {
      if (activeChat?.effort) setChats((prev) => prev.map((c) => (c.id === activeChat.id ? { ...c, effort: level } : c)));
      else setEffort(level);
    },
    effortLevels: effortLevels,
    recommendedEffort: recommendedEffort,
    workspace: workspace,
    onPickWorkspace: chooseWorkspace,
    recentWorkspaces: recentWorkspaces,
    onSelectWorkspace: (p) => void selectWorkspace(p),
    onCloseWorkspace: closeWorkspace,
    // The chat's own files: its worktree's when it has one.
    onListFiles: () => listProjectFiles(workDir),
    commands: allCommands,
    onSteer: steer,
    fillRef: fillInputRef,
    attachRef: attachElementRef,
    attachFilesRef: attachFilesRef,
  } satisfies Partial<ComponentProps<typeof ClaudeChatInput>>;

  /** Opens a session next to the open one; without an open chat, or for another folder's
   *  session, it just opens. */
  const openSessionToSide = (id: string) => {
    const ws = sessions.find((s) => s.id === id)?.workspace ?? chats.find((c) => c.id === id)?.workspace ?? workspace;
    const sameFolder = (ws ?? null) === (workspace ?? null);
    if (sameFolder) openToSide(id);
    void resumeSession(id, ws);
  };

  const paneChats = split
    ? [split.left, split.right].flatMap((id) => chats.filter((c) => c.id === id))
    : activeChat ? [activeChat] : [];
  const shownIds = paneChats.map((c) => c.id).join("\n");
  useEffect(() => { setShownChats(shownIds ? shownIds.split("\n") : []); }, [shownIds]);

  // What both panes of a split view share; the per-chat state goes to each ChatPane.
  const paneTranscript = {
    zoom: transcriptZoom(appearance.transcriptTextSize),
    widthClass: chatWidth,
    commandRunEnv,
    restorableMsgIds,
    onOpenView: (v: string) => openView(v as ViewId),
    onRevert: revertTo,
    onRetry: retryAssistant,
    onContinue: (chatId: string) => void continueCutTurn(chatId, wakeEnv()),
    onEdit: editUserMessage,
    onFork: forkMessage,
    onReviewChanges: openReview,
    queue: { items: queue.items, delivering: queue.delivering, paused: queue.paused, onEdit: queue.edit, onRemove: queue.remove, onMove: queue.move, onSendNow: queue.sendNow, onResume: queue.resume },
    onReplyToSelection: (message: string, { files, pastedContent, elements }: { files: AttachedFile[]; pastedContent: PastedSnippet[]; elements: PickedElement[] }) => {
      const payload = { message, files, pastedContent, model: effectiveModel, isThinkingEnabled: false, elements: elements.length ? elements : undefined };
      if (busy) queue.enqueue(payload);
      else void handleSend(payload);
    },
  };
  const panePrompts = {
    widthClass: chatWidth,
    planReady: permissionMode === "plan" && !streaming,
    onApplyPlan: applyPlan,
    onRespondPermission: respondPermission,
    onAnswerQuestion: respondQuestion,
  };
  const paneInput = { ...chatInputProps, placeholder: tChat.slashCommandsPlaceholder, suggestion: shownSuggestion, onQueue: queue.enqueue };
  const sideChatInput: SideChatInputBase = {
    models: modelOptions,
    onOpenSettings: () => navigate(navSnapshot({ settingsOpen: true, settingsSection: undefined })),
    onManageModels: () => setManageModelsOpen(true),
    workspace,
  };
  const sideChatProps = { chatId: activeId, messages: activeChat?.messages ?? [], modelId: effectiveModel, settings, input: sideChatInput };
  const usesClaudeCodeIn = (chat: Chat) => (chat.id === activeId ? usesClaudeCode : getModel(chat.model ?? effectiveModel, settings)?.provider === "claude-code");

  return (
    <div className="isolate flex flex-col h-full w-full bg-bg-0 text-text-100">
      <ModBackdrop hidden={section !== "code"} />
      <TitleBar
        onWhatsNew={() => setWhatsNewOpen(true)}
        onToggleView={toggleViewOf}
        // Changes takes about a second of git runs to read: they start when the pointer reaches
        // its button, and the view usually opens with them done.
        onPrepareView={(v) => { if (v === "diff" && workDir) prefetchChanges(workDir, diffModeFor(workDir), loadDiffSettings().hideWhitespace); }}
        openViews={section === "code" ? openViews : []}
        showChanges={(activeChat?.messages.length ?? 0) > 0}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        menu={{
          runShortcut: (id) => { if (shortcutsRef.current) runShortcutAction(id, shortcutsRef.current); },
          newTerminal: () => shortcutsRef.current?.openNewTerminal(),
          openFolder: chooseWorkspace,
          openSettings: (s) => navigate(navSnapshot({ settingsOpen: true, settingsSection: s })),
          whatsNew: () => setWhatsNewOpen(true),
          goBack,
          goForward,
          cycleSession: (step) => shortcutsRef.current?.cycleSession(step),
        }}
        onBack={goBack}
        onForward={goForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
      />
      <ChangelogModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <CornerNotices />
      <ThemeSound />
      <MinimizedViews onRestore={(v) => openView(v)} />
      <RagConsentDialog workspace={workspace} onIndex={(ws) => reindexRag(ws, true)} />
      <SshAskpassDialog />
      <TranscriptViewNotice />
      <CliResumeDialog workspace={workspace} onImport={importCliSession} />
      {sideFloating && <SideChatCard key={sideKey(activeId)} {...sideChatProps} />}
      <div className="flex flex-1 min-h-0 w-full">
      {sidebarOpen && (
      <Sidebar
        onOpenSearch={() => setSessionSearchOpen(true)}
        chats={summaries}
        activeChatId={activeId}
        streamingChatIds={streamingIds}
        awaitingPermissionChatIds={new Set(pending.map((p) => p.chatId))}
        awaitingQuestionChatIds={new Set(pendingQuestion ? [pendingQuestion.chatId] : [])}
        section={section}
        onSectionChange={(s) => navigate(navSnapshot({ section: s, settingsOpen: false, settingsSection: undefined }))}
        onNewChat={newChat}
        onSelectChat={(id) => {
          setActiveId(id);
          navigate(navSnapshot({ section: "code", settingsOpen: false, settingsSection: undefined }));
        }}
        onDeleteChat={deleteChat}
        onRenameChat={renameChat}
        onRenameSession={(id, title) => { void renameSavedSession(id, title); }}
        onOpenSettings={() => navigate(navSnapshot({ settingsOpen: true, settingsSection: undefined }))}
        // A project's sessions are reached from its page, not from Recents.
        sessions={orderedSessions.filter((s) => !s.projectId)}
        archivedSessions={archivedSessions.filter((s) => !s.projectId)}
        sessionStates={sessionStates}
        onOpenProject={projectsApi.openProject}
        activeProjectId={activeChat?.projectId}
        onSelectSession={(id) => { void resumeSession(id, sessions.find((s) => s.id === id)?.workspace); }}
        onDeleteSession={(id, withNested) => {
          void sessionActions.deleteSession(id, !!withNested, sessionActionsEnv()).catch((e) => console.error("deleting session failed", e));
        }}
        onRewindSession={(id) => { void sessionActions.rewindSavedSession(id, sessionActionsEnv()); }}
        onArchiveSession={(id) => { void sessionActions.archiveSession(id, sessionActionsEnv()); }}
        onArchiveSessions={(ids) => {
          // One after the other: each may ask about its uncommitted files.
          void (async () => {
            for (const id of ids) await sessionActions.archiveSession(id, sessionActionsEnv());
          })();
        }}
        onDeleteSessions={(ids) => {
          void (async () => {
            for (const id of ids) await sessionActions.deleteSession(id, false, sessionActionsEnv());
          })().catch((e) => console.error("deleting sessions failed", e));
        }}
        onOpenToSide={splitViewOn && activeChat ? openSessionToSide : undefined}
        onNewSideChat={(id) => {
          openSideChatFor(id);
          void resumeSession(id, sessions.find((s) => s.id === id)?.workspace);
        }}
        onForkSession={(id) => {
          void sessionActions.forkSession(id, sessionActionsEnv()).then((fork) => fork && resumeSession(fork.id, fork.workspace));
        }}
        onScheduleSession={(id) => {
          const session = sessions.find((s) => s.id === id);
          startRoutineDraft({ name: session?.title || chats.find((c) => c.id === id)?.title || "", prompt: "", workspace: session?.workspace ?? workspace ?? undefined });
          setSection("routines");
        }}
        onSkillFromSession={(id) => {
          // Opens the session, then its agent writes the skill from what it did there.
          // A turn running there ends first, as for a queued message.
          void (async () => {
            await resumeSession(id, sessions.find((s) => s.id === id)?.workspace);
            await turnDoneRef.current.get(id);
            const shown = t.sidebarMenu.turnIntoSkillMessage;
            await handleSendRef.current?.(textPayload(SKILL_FROM_SESSION_PROMPT, effectiveModel), shown, id);
          })();
        }}
        onCopySession={(id, what) => {
          void sessionActions.sessionCopyText(id, what, sessionActionsEnv()).then((text) => {
            if (text) void navigator.clipboard.writeText(text);
          });
        }}
        onMoveSession={(id, ws) => {
          void sessionActions.moveSession(id, ws, sessionActionsEnv()).then((moved) => {
            if (moved?.wasActive) void resumeSession(moved.id, moved.workspace);
          });
        }}
        uncommittedFilesOf={uncommittedFilesOf}
        sessionsLoaded={sessionsLoaded}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenArchived={() => { refreshSessions(); setArchivedOpen(true); }}
        archivedCount={archivedSessions.length}
        // A project's own data folder (its coordinator's, when it has no folder) isn't one of the user's.
        projects={[...new Set([workspace, ...recentWorkspaces].filter((w): w is string => !!w && !isProjectHubDir(w)))]}
        currentWorkspace={workspace}
        onNewSessionIn={(ws) => {
          void ensureWorkspaceActive(ws).then((ok) => {
            if (!ok) return;
            newChat();
            navigate(navSnapshot({ section: "code", settingsOpen: false, settingsSection: undefined }));
          });
        }}
        onOpenFolder={(ws) => { void invoke("agent_open_path", { path: ws }).catch(() => {}); }}
        onRemoveProject={(ws) => {
          forgetWorkspace(ws);
          refreshSessions();
        }}
      />
      )}

      <ArchivedSessionsModal
        open={archivedOpen}
        onClose={() => setArchivedOpen(false)}
        sessions={archivedSessions}
        onOpen={(s) => {
          void sessionActions.unarchiveSession(s, { refreshSessions }).then(() => {
            setArchivedOpen(false);
            void resumeSession(s.id, s.workspace);
          });
        }}
        onUnarchive={(s) => { void sessionActions.unarchiveSession(s, { refreshSessions }); }}
      />

      <main data-side-chat-area className={cn("flex-1 flex flex-col min-w-0", panelMaximized && panelShown && "hidden")}>
        {section === "customize" ? (
          <CustomizePanel workspace={workspace} onStartChat={startChatWithPrompt} />
        ) : section === "projects" ? (
          <ProjectsPage
            loaded={projectsApi.loaded}
            recentFolders={[workspace, ...recentWorkspaces].filter((w): w is string => !!w)}
            onOpen={projectsApi.openProject}
            onCreate={projectsApi.createProject}
            onOpenCloudSettings={() => navigate(navSnapshot({ settingsOpen: true, settingsSection: "nube" }))}
          />
        ) : section === "routines" ? (
          <RoutinesPanel
            onRun={runRoutine}
            onStartChat={startChatWithPrompt}
            models={modelOptions}
            defaultModel={effectiveModel}
          />
        ) : section !== "code" ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
            <h2 className="text-2xl font-serif font-light text-text-200 mb-2">
              {(t.sidebarMenu as Record<string, string>)[section] ?? sectionLabel(section)}{" "}
              <span className="text-accent">·</span> {tApp.comingSoon}
            </h2>
            <p className="text-sm text-text-400">{tApp.sectionReserved}</p>
          </div>
        ) : (
        <>
        {activeChat ? (
          <SessionDropZone enabled={splitViewOn} onOpenSession={openSessionToSide}>
            <ProjectFrame
              chat={activeChat}
              models={modelOptions}
              defaultModel={effectiveModel}
              onOpenProject={projectsApi.openProject}
              onOpenScheduled={() => navigate(navSnapshot({ section: "routines", settingsOpen: false, settingsSection: undefined }))}
              onSave={projectsApi.updateProject}
              onDelete={projectsApi.removeProject}
            >
            <div className={cn("flex-1 flex min-h-0 min-w-0", split && "gap-2 p-2")}>
              {paneChats.map((chat, i) => (
                // Keyed by position, so the single view keeps its composer and scroll when the
                // open chat changes, as before split view existed.
                <ChatPane
                  key={i}
                  chat={chat}
                  split={!!split}
                  focused={chat.id === activeId}
                  streaming={streamingIds.has(chat.id)}
                  side={turnSide[chat.id]}
                  compacting={compactingIds.has(chat.id)}
                  pending={pending.filter((p) => p.chatId === chat.id)}
                  question={pendingQuestion?.chatId === chat.id ? pendingQuestion : null}
                  onFocus={() => setActiveId(chat.id)}
                  onStop={() => abortTurn(chat.id)}
                  onClose={() => closePane(chat.id)}
                  onHighlightsChange={(chatId, messageId, next) => patchMessage(chatId, messageId, (m) => ({ ...m, highlights: next.length ? next : undefined }))}
                  findOpen={findOpen}
                  onCloseFind={() => setFindOpen(false)}
                  transcript={paneTranscript}
                  prompts={panePrompts}
                  input={chat.projectRole === "coordinator" ? { ...paneInput, placeholder: t.projects.composerPlaceholder } : paneInput}
                  topBar={<><ModBand sessionKey={chat.id} isWorking={streamingIds.has(chat.id)} />{usesClaudeCodeIn(chat) && <PlanLimitBar />}{chat.goal && (
                    <GoalCard
                      chatId={chat.id}
                      goal={chat.goal}
                      working={streamingIds.has(chat.id)}
                      onEdit={() => fillInputRef.current?.(`/goal ${chat.goal?.text ?? ""}`)}
                      onClear={() => setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, goal: undefined } : c)))}
                    />
                  )}{chat.messages.length > 0 && gitBarOf(chat.worktree?.path ?? workspace, streamingIds.has(chat.id), { id: chat.id, workspace: chat.workspace ?? workspace })}</>}
                />
              ))}
            </div>
            </ProjectFrame>
          </SessionDropZone>
        ) : (
          // A new session with no messages yet: drifting glyphs behind the empty screen.
          <GlyphBackground className="flex-1 flex flex-col min-h-0" glowColor="var(--text-400)" shapeColor="var(--accent)">
            <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pt-6">
              {workspace && lastHere && (
                <div className="max-w-2xl mx-auto px-2 mt-3 flex justify-center">
                  <button
                    onClick={() => void resumeSession(lastHere.id, lastHere.workspace ?? workspace)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[8px] border border-bg-300 bg-bg-100 text-sm text-text-200 hover:bg-bg-200 transition-colors"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                    <span className="truncate max-w-[20rem]">
                      {tApp.continueLastSession}
                      {lastHere.title ? ` · ${lastHere.title}` : ""}
                    </span>
                  </button>
                </div>
              )}
            </div>
            <div className="relative px-4 pb-2 pt-2 shrink-0">
              <div className={cn("relative mx-auto", chatWidth)}>
                <ClaudeChatInput
                  {...chatInputProps}
                  placeholder={tChat.codingRequestPlaceholder}
                  lockWorkspace={false}
                  mascot="intro"
                  topBar={<><ModBand sessionKey={draftModKey(workspace)} isWorking={false} />{planBar}</>}
                  draftKey={`new:${workspace ?? ""}`}
                />
              </div>
            </div>
          </GlyphBackground>
        )}
        </>
        )}
      </main>

      <ViewsPanel
        open={panelShown}
        views={openViews}
        onCloseView={(v) => (v === "sidechat" ? closeSideChat() : patchViews((cur) => withoutView(cur, v)))}
        onMinimizeView={(v) => {
          patchViews((cur) => withoutView(cur, v));
          minimizeView(v);
        }}
        sideChat={(pane) => <SideChatPane key={sideKey(activeId)} {...sideChatProps} {...pane} />}
        plan={activeChat?.plan ?? ""}
        workspace={workDir}
        previews={previewSlots}
        activePreviewSlot={currentViews?.slot}
        diffNonce={diffNonce}
        diffFocus={diffFocus}
        onRequestDevServer={requestDevServer}
        onAddServer={requestAddServer}
        onPickElement={pickElementContext}
        onAttachImage={attachPreviewImage}
        chatId={activeChat?.id}
        onMaximizedChange={setPanelMaximized}
      />
      </div>

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        workspace={workspace}
        onClose={closeSettings}
        onSectionChange={setSettingsSection}
        onChange={setSettings}
        rules={rules}
        onDeleteRule={deleteRule}
        onClearRules={clearRules}
        onWhatsNew={() => { closeSettings(); setWhatsNewOpen(true); }}
        initialSection={settingsSection}
      />

      <ManageModelsModal
        open={manageModelsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setManageModelsOpen(false)}
        onConnectProvider={() => navigate(navSnapshot({ settingsOpen: true, settingsSection: "providers" }))}
      />

      <DoctorModal
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        settings={settings}
        workspace={workspace}
        permissionMode={permissionMode}
        selectedModel={effectiveModel}
      />

      <HelpModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        skillCommands={skillCommands}
        fileCommands={fileCommands}
      />

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {sessionSearchOpen && (
        <SessionSearchModal
          onClose={() => setSessionSearchOpen(false)}
          workspaces={[workspace, ...recentWorkspaces]}
          onOpen={(hit) => { void resumeSession(hit.sessionId, hit.workspace); }}
        />
      )}

      {pendingOpenProject && (
        <OpenProjectModal
          onOpen={() => respondOpenProject(true)}
          onCancel={() => respondOpenProject(false)}
        />
      )}

      {pendingRewind && (
        <RewindDialog
          prompt={pendingRewind.prompt}
          preview={pendingRewind.preview}
          onConfirm={(mode) => void confirmRewind(mode)}
          onCancel={cancelRewind}
        />
      )}
      {confirmElement}
      {pendingTrust && (
        <TrustWorkspaceModal
          path={pendingTrust.path}
          kind={pendingTrust.kind}
          status={pendingTrust.status}
          findings={pendingTrust.findings}
          onTrust={() => respondTrust(true)}
          onCancel={() => respondTrust(false)}
        />
      )}

      {pendingOnboarding && (
        <ProjectOnboardingModal
          name={pendingOnboarding.name}
          onCreate={() => void createProjectMemory()}
          onDismiss={dismissProjectOnboarding}
        />
      )}

      <TooltipLayer />
    </div>
  );
}
