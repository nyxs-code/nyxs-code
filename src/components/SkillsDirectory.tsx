import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ExternalLink, Loader2, Plus, RefreshCw, ScrollText, Search, Check,
} from "lucide-react";
import { loadSkills, type SkillDef } from "@/lib/skills";
import { handleExternalLinkClick } from "@/lib/openExternal";
import { browseSkills, type SkillsShEntry } from "@/lib/skillsSh";
import { installSkillFromGithub, type SkillInstallScope } from "@/lib/skillsInstall";
import { isTauri } from "@/lib/plugins/paths";
import { localizedError, useTranslations } from "@/lib/i18n";
import { accountKey } from "@/lib/accountScope";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type View = "installed" | "explore";

const INSTALL_SCOPE_KEY = "nyxs.skill-install-scope.v1";

function loadInstallScope(workspace: string | null): SkillInstallScope {
  const saved = localStorage.getItem(accountKey(INSTALL_SCOPE_KEY));
  if (saved === "project" || saved === "user") {
    if (saved === "project" && !workspace) return "user";
    return saved;
  }
  return workspace ? "project" : "user";
}

export function SkillsDirectory({ workspace }: { workspace: string | null }) {
  const t = useTranslations().directory;
  const [view, setView] = useState<View>("explore");
  const [installed, setInstalled] = useState<SkillDef[] | null>(null);
  const [catalog, setCatalog] = useState<SkillsShEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<SkillsShEntry | null>(null);
  const [modalScope, setModalScope] = useState<SkillInstallScope>("user");

  const popularityRank = useMemo(() => {
    const sorted = [...(catalog ?? [])].sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
    const map = new Map<string, number>();
    sorted.forEach((s, i) => {
      if ((s.installs ?? 0) > 0) map.set(s.id, i + 1);
    });
    return map;
  }, [catalog]);

  const installedInScope = useMemo(() => {
    const global = new Set<string>();
    const project = new Set<string>();
    for (const s of installed ?? []) {
      const set = s.source === "project" ? project : global;
      set.add(s.name);
      const fromDir = s.dir.replace(/\\/g, "/").split("/").pop();
      if (fromDir) set.add(fromDir);
    }
    return { global, project };
  }, [installed]);

  const entryInSet = useCallback((entry: SkillsShEntry, folders: Set<string>) => {
    const slug = entry.slug.toLowerCase();
    const id = entry.id.split("/").pop()?.toLowerCase() ?? slug;
    for (const f of folders) {
      const n = f.toLowerCase();
      if (n === slug || n === id || n === entry.name.toLowerCase()) return true;
    }
    return false;
  }, []);

  const installStatus = useCallback(
    (entry: SkillsShEntry): "both" | "global" | "project" | "none" => {
      const inG = entryInSet(entry, installedInScope.global);
      const inP = entryInSet(entry, installedInScope.project);
      if (inG && inP) return "both";
      if (inG) return "global";
      if (inP) return "project";
      return "none";
    },
    [entryInSet, installedInScope],
  );

  const reloadInstalled = useCallback(async () => {
    setInstalled(await loadSkills(workspace));
  }, [workspace]);

  // Searches overlap while the user types: only the latest one's answer is shown, whichever
  // arrives last.
  const searchSeq = useRef(0);
  const loadCatalog = useCallback(async (force = false) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const found = await browseSkills({ query, force });
      if (seq === searchSeq.current) setCatalog(found);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setCatalog([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void Promise.resolve().then(reloadInstalled);
  }, [reloadInstalled]);

  useEffect(() => {
    if (view === "installed") void Promise.resolve().then(reloadInstalled);
  }, [view, reloadInstalled]);

  const openInstallModal = (entry: SkillsShEntry) => {
    if (!isTauri) {
      setError(t.installRequiresDesktop);
      return;
    }
    setModalScope(loadInstallScope(workspace));
    setPendingInstall(entry);
    setError(null);
  };

  useEffect(() => {
    if (view !== "explore") return;
    const id = window.setTimeout(() => void loadCatalog(), query ? 280 : 0);
    return () => window.clearTimeout(id);
  }, [view, query, loadCatalog]);

  const confirmInstall = async () => {
    const entry = pendingInstall;
    if (!entry) return;
    if (modalScope === "project" && !workspace) {
      setError(t.installScopeProjectDisabled);
      return;
    }
    if (entryInSet(entry, modalScope === "project" ? installedInScope.project : installedInScope.global)) {
      setPendingInstall(null);
      return;
    }
    localStorage.setItem(accountKey(INSTALL_SCOPE_KEY), modalScope);
    setBusySlug(entry.id);
    setError(null);
    try {
      await installSkillFromGithub(entry.source, entry.slug, { scope: modalScope, workspace });
      setPendingInstall(null);
      await reloadInstalled();
      setView("installed");
    } catch (e) {
      setError(`${t.installError}: ${localizedError(e)}`);
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-text-100">{t.skillsTitle}</h2>
        <p className="text-sm text-text-400 mt-1">
          {t.skillsDesc}{" "}
          <a
            href="https://www.skills.sh/"
            onClick={handleExternalLinkClick}
            rel="noreferrer"
            className="text-accent hover:underline inline-flex items-center gap-0.5"
          >
            {t.skillsShLink} <ExternalLink className="w-3 h-3" />
          </a>
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <TabButton active={view === "installed"} onClick={() => setView("installed")}>
          {t.installed}
          {installed && installed.length > 0 && (
            <span className="ml-1 text-[10px] text-text-500">({installed.length})</span>
          )}
        </TabButton>
        <TabButton active={view === "explore"} onClick={() => setView("explore")}>
          {t.explore}
        </TabButton>
      </div>

      {view === "installed" && (
        <InstalledSection
          skills={installed}
          onRefresh={() => void reloadInstalled()}
          emptyLabel={t.noInstalled}
          loadingLabel={t.loading}
          refreshLabel={t.refresh}
        />
      )}

      {view === "explore" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-[8px] bg-bg-200 border border-bg-300 text-text-100 placeholder:text-text-400 outline-none focus:border-accent"
              />
            </div>
            <button
              type="button"
              onClick={() => void loadCatalog(true)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-[8px] text-xs font-medium border border-bg-300 text-text-200 hover:bg-bg-200 disabled:opacity-50 shrink-0"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {t.refresh}
            </button>
          </div>

          {error && <p className="text-[12px] text-red-400 break-words">{error}</p>}

          {loading && catalog === null ? (
            <p className="text-sm text-text-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> {t.loading}
            </p>
          ) : (catalog ?? []).length === 0 ? (
            <p className="text-sm text-text-500 italic">{t.noResults}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[min(52vh,520px)] overflow-y-auto custom-scrollbar pr-1">
              {(catalog ?? []).map((entry) => {
                const status = installStatus(entry);
                const here = status === "both";
                const rank = popularityRank.get(entry.id) ?? 0;
                return (
                  <SkillCatalogCard
                    key={entry.id}
                    entry={entry}
                    subtitle={skillSubtitle(entry, rank, t)}
                    installed={here}
                    busy={busySlug === entry.id}
                    installLabel={t.install}
                    installedLabel={t.installedBadge}
                    onInstall={() => openInstallModal(entry)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {pendingInstall && (
        <SkillInstallScopeModal
          entry={pendingInstall}
          scope={modalScope}
          hasWorkspace={!!workspace}
          busy={busySlug === pendingInstall.id}
          installedGlobal={entryInSet(pendingInstall, installedInScope.global)}
          installedProject={entryInSet(pendingInstall, installedInScope.project)}
          onScope={setModalScope}
          onConfirm={() => void confirmInstall()}
          onClose={() => setPendingInstall(null)}
          t={t}
        />
      )}
    </div>
  );
}

function SkillInstallScopeModal({
  entry,
  scope,
  hasWorkspace,
  busy,
  installedGlobal,
  installedProject,
  onScope,
  onConfirm,
  onClose,
  t,
}: {
  entry: SkillsShEntry;
  scope: SkillInstallScope;
  hasWorkspace: boolean;
  busy: boolean;
  installedGlobal: boolean;
  installedProject: boolean;
  onScope: (s: SkillInstallScope) => void;
  onConfirm: () => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>["directory"];
}) {
  const alreadyInScope =
    scope === "project" ? installedProject : installedGlobal;
  const canConfirm =
    !busy &&
    !alreadyInScope &&
    (scope === "user" || hasWorkspace);

  return (
    <Dialog open onClose={onClose} stacked className="p-5 space-y-4">
      <DialogHeader className="p-0">
        <ScrollText className="w-5 h-5 text-text-400 shrink-0" />
        <DialogTitle className="text-base font-semibold truncate">
          {t.installModalTitle.replace("{name}", entry.name)}
        </DialogTitle>
      </DialogHeader>

      <p className="text-[12px] text-text-400">{t.installScopeLabel}</p>

      <div className="flex flex-col gap-2">
        <ScopeOption
          active={scope === "user"}
          disabled={installedGlobal}
          title={t.installScopeGlobal}
          hint={t.installScopeGlobalHint}
          installed={installedGlobal}
          installedLabel={t.installedBadge}
          onClick={() => onScope("user")}
        />
        <ScopeOption
          active={scope === "project"}
          disabled={!hasWorkspace || installedProject}
          title={t.installScopeProject}
          hint={hasWorkspace ? t.installScopeProjectHint : t.installScopeProjectDisabled}
          installed={installedProject}
          installedLabel={t.installedBadge}
          onClick={() => hasWorkspace && onScope("project")}
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onClose}>{t.cancel}</Button>
        <Button variant="primary" onClick={onConfirm} disabled={!canConfirm}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t.install}
        </Button>
      </div>
    </Dialog>
  );
}

function ScopeOption({
  active,
  disabled,
  title,
  hint,
  installed,
  installedLabel,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  title: string;
  hint: string;
  installed: boolean;
  installedLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-3 py-2.5 rounded-lg text-left border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        active ? "border-accent bg-accent/10 text-text-100" : "border-bg-300 text-text-300 hover:bg-bg-200"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="block text-[13px] font-medium">{title}</span>
        {installed && (
          <span className="text-[10px] text-green-400 shrink-0">{installedLabel}</span>
        )}
      </span>
      <span className="block text-[10px] font-mono text-text-500 mt-0.5">{hint}</span>
    </button>
  );
}

const SKILL_ICON_COLORS = ["#7c8aff", "#4285f4", "#10a37f", "#d97757", "#a78bfa", "#635bff", "#94a3b8"];

function skillIconColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return SKILL_ICON_COLORS[Math.abs(h) % SKILL_ICON_COLORS.length];
}

function SkillIcon({ name, seed }: { name: string; seed: string }) {
  const color = skillIconColor(seed);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className="w-10 h-10 shrink-0 rounded-[8px] flex items-center justify-center text-sm font-bold"
      style={{ backgroundColor: `${color}22`, color }}
    >
      {letter}
    </span>
  );
}

function skillSubtitle(
  entry: SkillsShEntry,
  rank: number,
  t: ReturnType<typeof useTranslations>["directory"],
): string {
  if (rank === 1) return t.mostPopular;
  if (rank > 1) return t.popularRank.replace("{rank}", String(rank));
  if (entry.installs != null) return `${entry.installs.toLocaleString()} ${t.installsLabel}`;
  return entry.source;
}

function SkillCatalogCard({
  entry,
  subtitle,
  installed,
  busy,
  installLabel,
  installedLabel,
  onInstall,
}: {
  entry: SkillsShEntry;
  subtitle: string;
  installed: boolean;
  busy: boolean;
  installLabel: string;
  installedLabel: string;
  onInstall: () => void;
}) {
  const description = entry.description?.trim() || "—";
  return (
    <div className="rounded-[8px] border border-bg-300 bg-bg-100 hover:bg-bg-200 hover:border-bg-300 transition-colors p-4 flex flex-col gap-3 min-h-[132px]">
      <div className="flex items-start gap-3">
        <SkillIcon name={entry.name} seed={entry.id} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[14px] font-semibold text-text-100 truncate">{entry.name}</span>
          </span>
          <span className="block text-[12px] text-text-400 mt-0.5 truncate">{subtitle}</span>
        </span>
        <button
          type="button"
          disabled={busy || installed}
          onClick={onInstall}
          className="shrink-0 p-1 rounded-md text-text-400 disabled:opacity-50"
          aria-label={installed ? installedLabel : installLabel}
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : installed ? (
            <Check className="w-4 h-4 text-green-400" />
          ) : (
            <Plus className="w-4 h-4 hover:text-text-100" />
          )}
        </button>
      </div>
      <p className="text-[12px] text-text-400 leading-snug line-clamp-2 flex-1">{description}</p>
    </div>
  );
}

function SkillInstalledCard({ skill, sourceLabel }: { skill: SkillDef; sourceLabel: string }) {
  const description = skill.description?.trim() || "—";
  return (
    <div className="rounded-[8px] border border-bg-300 bg-bg-100 p-4 flex flex-col gap-3 min-h-[132px]">
      <div className="flex items-start gap-3">
        <SkillIcon name={skill.name} seed={skill.name} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-[14px] font-semibold text-text-100 truncate">{skill.name}</span>
            <Check className="w-4 h-4 text-green-400 shrink-0" />
          </span>
          <span className="block text-[12px] text-text-400 mt-0.5 uppercase tracking-wide">{sourceLabel}</span>
        </span>
      </div>
      <p className="text-[12px] text-text-400 leading-snug line-clamp-2 flex-1">{description}</p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        active ? "bg-bg-200 text-text-100" : "text-text-400 hover:bg-bg-200 hover:text-text-200"
      }`}
    >
      {children}
    </button>
  );
}

function InstalledSection({
  skills,
  onRefresh,
  emptyLabel,
  loadingLabel,
  refreshLabel,
}: {
  skills: SkillDef[] | null;
  onRefresh: () => void;
  emptyLabel: string;
  loadingLabel: string;
  refreshLabel: string;
}) {
  if (skills === null) {
    return (
      <p className="text-sm text-text-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> {loadingLabel}
      </p>
    );
  }
  if (skills.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-bg-300 p-6 text-center">
        <ScrollText className="w-6 h-6 text-text-400 mx-auto mb-2" />
        <p className="text-sm text-text-300">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={onRefresh}
        className="text-[11px] text-text-400 hover:text-text-200 mb-2"
      >
        {refreshLabel}
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[min(52vh,520px)] overflow-y-auto custom-scrollbar pr-1">
        {skills.map((s) => (
          <SkillInstalledCard key={`${s.source}:${s.name}`} skill={s} sourceLabel={s.source} />
        ))}
      </div>
    </>
  );
}

export default SkillsDirectory;
