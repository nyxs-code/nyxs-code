import { useState, useEffect, useRef, type ReactNode } from "react";
import { Check, Loader2, Copy, MoreVertical } from "lucide-react";
import { useConfirm } from "@/lib/useConfirm";
import { useTranslations } from "@/lib/i18n";
import {
  getMe,
  userInitials,
  listSessions,
  finishSession,
  logoutAll,
  deleteAccount,
  type AuthUser,
  type AuthSession,
} from "@/lib/auth";
import { SectionTitle } from "./settingsControls";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SessionRow({ session, onFinish }: { session: AuthSession; onFinish: (id: string) => void }) {
  const t = useTranslations().settings.accountPage;
  const [menuOpen, setMenuOpen] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setMenuOpen((o) => !o);
  };
  return (
    <tr className="border-t border-bg-300">
      <td className="py-2.5 pr-3 whitespace-nowrap">
        <span className="text-sm text-text-100">{(session.device || t.unknownDevice).replace(/\s*\(.*?\)\s*$/, "")}</span>
        {session.current && (
          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/20 text-accent align-middle">
            {t.current}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-sm text-text-300 whitespace-nowrap">{session.location || "—"}</td>
      <td className="py-2.5 pr-3 text-sm text-text-300 whitespace-nowrap">{fmtDate(session.createdAt)}</td>
      <td className="py-2.5 pr-3 text-sm text-text-300 whitespace-nowrap">{fmtDate(session.updatedAt)}</td>
      <td className="py-2.5 w-8">
        <button
          ref={btnRef}
          onClick={openMenu}
          onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-300 hover:text-text-100 hover:bg-bg-200 transition-colors"
          aria-label={t.sessionOptions}
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div
            className="fixed z-50 min-w-[120px] rounded-lg border border-bg-300 bg-bg-0 shadow-lg py-1"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            <button
              onMouseDown={(e) => { e.preventDefault(); setMenuOpen(false); onFinish(session.id); }}
              className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-bg-200"
            >
              {t.finish}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function AccountSection({ title }: { title: ReactNode }) {
  const tr = useTranslations();
  const t = tr.settings.accountPage;
  const [confirm, confirmElement] = useConfirm();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshSessions = () => listSessions().then(setSessions).catch(() => {});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [me, sess] = await Promise.all([getMe(), listSessions()]);
        if (!alive) return;
        setUser(me);
        setSessions(sess);
      } catch {

      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const copyOrg = async () => {
    if (!user?.orgId) return;
    await navigator.clipboard.writeText(user.orgId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleLogoutAll = async () => {
    const ok = await confirm({
      title: t.signOutAllRow,
      message: t.confirmLogoutAll,
      confirmLabel: t.signOut,
      cancelLabel: tr.modals.cancel,
    });
    if (!ok) return;
    setBusy("logout");
    try {
      await logoutAll(true);
      await refreshSessions();
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t.deleteAccount,
      message: t.confirmDelete,
      confirmLabel: t.deleteAccount,
      cancelLabel: tr.modals.cancel,
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await deleteAccount();
      window.location.reload();
    } catch {
      setBusy(null);
    }
  };

  const handleFinish = async (id: string) => {
    const wasCurrent = sessions.find((s) => s.id === id)?.current;
    try {
      await finishSession(id);
      if (wasCurrent) window.location.reload();
      else refreshSessions();
    } catch {

    }
  };

  if (loading) {
    return (
      <div>
        <SectionTitle>{title}</SectionTitle>
        <Loader2 className="w-5 h-5 text-text-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div>
        <SectionTitle>{title}</SectionTitle>
        <p className="text-sm text-text-400">{t.notLoggedIn}</p>
      </div>
    );
  }

  return (
    <div>
      <SectionTitle>{title}</SectionTitle>

      <div className="flex items-center gap-3 p-4 rounded-lg border border-bg-300 bg-bg-100">
        {user.picture ? (
          <img src={user.picture} alt="" className="w-10 h-10 rounded-lg object-cover" referrerPolicy="no-referrer" draggable={false} />
        ) : (
          <span className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center text-sm font-bold text-bg-0">
            {userInitials(user)}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-100 truncate">{user.name || user.email}</p>
          <p className="text-xs text-text-400 truncate">{user.email}</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-bg-300 bg-bg-100 divide-y divide-bg-300">
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="text-sm text-text-200">{t.signOutAllRow}</span>
          <button
            onClick={handleLogoutAll}
            disabled={busy === "logout"}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-bg-300 text-text-100 hover:bg-bg-200 disabled:opacity-60 transition-colors shrink-0"
          >
            {busy === "logout" ? "…" : t.signOut}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="text-sm text-text-200">{t.deleteRow}</span>
          <button
            onClick={handleDelete}
            disabled={busy === "delete"}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-60 transition-colors shrink-0"
          >
            {busy === "delete" ? "…" : t.deleteAccount}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="text-sm text-text-200">{t.orgId}</span>
          <button
            onClick={copyOrg}
            data-tooltip={copied ? t.copied : t.copy}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono text-text-300 bg-bg-200 hover:bg-bg-300 transition-colors shrink-0"
          >
            {user.orgId || "—"}
            {copied ? <Check className="w-3 h-3 text-accent" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-100 mb-2">{t.activeSessions}</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-text-400">{t.noActiveSessions}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-bg-300 bg-bg-100 px-4">
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs text-text-400">
                  <th className="py-2 pr-3 font-medium">{t.colDevice}</th>
                  <th className="py-2 pr-3 font-medium">{t.colLocation}</th>
                  <th className="py-2 pr-3 font-medium">{t.colCreated}</th>
                  <th className="py-2 pr-3 font-medium">{t.colUpdated}</th>
                  <th className="py-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <SessionRow key={s.id} session={s} onFinish={handleFinish} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirmElement}
    </div>
  );
}
