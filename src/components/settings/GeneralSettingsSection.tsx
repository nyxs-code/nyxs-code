import { useState, useEffect, useRef, type ReactNode } from "react";
import { Monitor, Sun, Moon, Heart, Play } from "lucide-react";
import { loadGlobalConfig, updateGeneralPreferences, type GeneralPreferences } from "@/lib/globalConfig";
import { NOTIFICATION_DEFAULTS, resolveNotificationSound, type NotificationKind } from "@/lib/notificationPrefs";
import { NOTIFICATION_SOUND_IDS, playNotificationSound } from "@/lib/notificationSounds";
import { useTranslations, type Translations } from "@/lib/i18n";
import { getMe, updateName, userInitials, type AuthUser } from "@/lib/auth";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { useSettings } from "@/lib/useSettings";
import { ThemeColorsCard } from "./ThemeColorsCard";
import { TitleGenerationRow } from "./TitleGenerationRow";
import { SettingSelect } from "./SettingSelect";
import { SettingsToggle } from "./settingsControls";
import { fieldInputClass } from "./fieldClasses";
import { useSaveOnLeave } from "./useSaveOnLeave";

const WORK_ROLES = ["engineering", "design", "product", "research", "education", "other"] as const;
const CHAT_FONTS = ["system", "serif", "mono"] as const;
const APPEARANCE_PREFS: ThemePreference[] = ["auto", "light", "dark", "pink"];

type NotifKey = keyof NonNullable<GeneralPreferences["notifications"]>;

const NOTIF_ITEMS: { key: NotifKey; title: keyof Translations["settings"]["generalPage"]; desc: keyof Translations["settings"]["generalPage"] }[] = [
  { key: "responseCompletions", title: "notifResponseCompletionsTitle", desc: "notifResponseCompletionsDesc" },
  { key: "codeUpdates", title: "notifCodeUpdatesTitle", desc: "notifCodeUpdatesDesc" },
  { key: "codePermissionRequests", title: "notifCodePermissionsTitle", desc: "notifCodePermissionsDesc" },
  { key: "otherSessions", title: "notifOtherSessionsTitle", desc: "notifOtherSessionsDesc" },
];

function GeneralFieldLabel({ children }: { children: ReactNode }) {
  return <label className="block text-sm text-text-200 mb-1.5">{children}</label>;
}

export function GeneralSettingsSection() {
  const g = useTranslations().settings.generalPage;
  const a = useTranslations().settings.appearance;
  const { preference, resolved: resolvedTheme, setPreference } = useTheme();
  const { settings, update } = useSettings();
  const promptSuggestions = (settings as { promptSuggestions?: boolean }).promptSuggestions ?? true;
  const [prefs, setPrefs] = useState<GeneralPreferences>({});
  // The text fields' values as last saved, to tell what is still unsaved when Settings closes.
  const stored = useRef<Pick<GeneralPreferences, "displayName" | "customInstructions">>({});

  const [account, setAccount] = useState<AuthUser | null>(null);
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    void loadGlobalConfig().then((cfg) => {
      setPrefs(cfg.general ?? {});
      stored.current = { displayName: cfg.general?.displayName, customInstructions: cfg.general?.customInstructions };
    });
    void getMe()
      .then((u) => { setAccount(u); setFullName(u.name ?? ""); })
      .catch(() => {});
  }, []);

  const saveFullName = async () => {
    const name = fullName.trim();
    if (name === (account?.name ?? "")) return;
    try {
      const updated = await updateName(name);
      setAccount(updated);
      setFullName(updated.name ?? "");
      void patch({ fullName: updated.name ?? "" });
    } catch {
      /* ignore — keep the field value for retry */
    }
  };

  const patch = async (partial: Partial<GeneralPreferences>) => {
    setPrefs((prev) => ({
      ...prev,
      ...partial,
      notifications: partial.notifications
        ? { ...prev.notifications, ...partial.notifications }
        : prev.notifications,
    }));
    if ("displayName" in partial) stored.current.displayName = partial.displayName;
    if ("customInstructions" in partial) stored.current.customInstructions = partial.customInstructions;
    await updateGeneralPreferences(partial);
  };

  // A field still being typed in when Settings closes never loses focus: save it then.
  useSaveOnLeave(() => {
    const unsaved: Partial<GeneralPreferences> = {};
    if ((prefs.displayName ?? "") !== (stored.current.displayName ?? "")) unsaved.displayName = prefs.displayName;
    if ((prefs.customInstructions ?? "") !== (stored.current.customInstructions ?? "")) unsaved.customInstructions = prefs.customInstructions;
    if (Object.keys(unsaved).length) void updateGeneralPreferences(unsaved);
    void saveFullName();
  });

  const appearanceValue =
    APPEARANCE_PREFS.includes(preference as ThemePreference) ? preference : "auto";
  const notificationSound = resolveNotificationSound(prefs.notificationSound);

  return (
    <div className="space-y-10">
      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{g.profile}</h3>
        <div className="divide-y divide-bg-300 border-t border-bg-300 mb-4">
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.avatar}</span>
            {account?.picture ? (
              <img src={account.picture} alt="" className="w-12 h-12 rounded-full object-cover ring-2 ring-bg-300" referrerPolicy="no-referrer" draggable={false} />
            ) : (
              <span className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-400/80 via-accent/60 to-cyan-500/70 flex items-center justify-center text-base font-bold text-bg-0 ring-2 ring-bg-300">
                {account ? userInitials(account) : "?"}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.fullName}</span>
            <input
              type="text"
              className={`${fieldInputClass} max-w-[220px]`}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={() => void saveFullName()}
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.displayName}</span>
            <input
              type="text"
              className={`${fieldInputClass} max-w-[220px]`}
              value={prefs.displayName ?? ""}
              onChange={(e) => setPrefs((p) => ({ ...p, displayName: e.target.value }))}
              onBlur={(e) => void patch({ displayName: e.target.value })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.workRole}</span>
            <SettingSelect<string>
              ariaLabel={g.workRole}
              value={prefs.workRole ?? ""}
              options={[{ id: "", label: g.workRoleSelect }, ...WORK_ROLES.map((id) => ({ id, label: g.workRoles[id] }))]}
              onChange={(id) => {
                const workRole = id || undefined;
                setPrefs((p) => ({ ...p, workRole }));
                void patch({ workRole });
              }}
            />
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <GeneralFieldLabel>{g.customInstructions}</GeneralFieldLabel>
            <p className="text-[12px] text-text-400 mb-2">{g.customInstructionsDesc}</p>
            <textarea
              rows={4}
              className={`${fieldInputClass} resize-y min-h-[96px]`}
              placeholder={g.customInstructionsPlaceholder}
              value={prefs.customInstructions ?? ""}
              onChange={(e) => setPrefs((p) => ({ ...p, customInstructions: e.target.value }))}
              onBlur={(e) => void patch({ customInstructions: e.target.value })}
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{g.preferences}</h3>
        <div className="divide-y divide-bg-300 border-t border-bg-300">
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.appearance}</span>
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-200 border border-bg-300">
              {APPEARANCE_PREFS.map((pref) => {
                const Icon = pref === "auto" ? Monitor : pref === "light" ? Sun : pref === "pink" ? Heart : Moon;
                const label = pref === "auto" ? a.auto : pref === "light" ? a.light : pref === "pink" ? a.pink : a.dark;
                const selected = appearanceValue === pref;
                return (
                  <button
                    key={pref}
                    type="button"
                    onClick={() => setPreference(pref)}
                    className={`p-2 rounded-md transition-colors ${selected ? "bg-bg-0 text-text-100 shadow-sm" : "text-text-400 hover:text-text-200"}`}
                    data-tooltip={label}
                    aria-label={label}
                  >
                    <Icon className="w-4 h-4" />
                  </button>
                );
              })}
            </div>
          </div>
          {/* Only the mode in use (in Auto, the one the system is in). Pink and high contrast keep
              their own palettes, so there is nothing to tune there. */}
          {(resolvedTheme === "light" || resolvedTheme === "dark") && (
            <div className="py-4">
              <ThemeColorsCard key={resolvedTheme} mode={resolvedTheme} />
            </div>
          )}
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="text-sm text-text-100">{g.chatFont}</span>
            <SettingSelect<string>
              ariaLabel={g.chatFont}
              value={prefs.chatFont ?? "system"}
              options={CHAT_FONTS.map((id) => ({ id, label: g.chatFonts[id] }))}
              onChange={(id) => void patch({ chatFont: id })}
            />
          </div>
          <div className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-100">{g.promptSuggestionsTitle}</p>
              <p className="text-[12px] text-text-400 mt-0.5">{g.promptSuggestionsDesc}</p>
            </div>
            <SettingsToggle
              label={g.promptSuggestionsTitle}
              checked={promptSuggestions}
              onChange={(v) => update({ promptSuggestions: v } as Parameters<typeof update>[0], "user")}
            />
          </div>
          <TitleGenerationRow />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-100 mb-2">{g.notifications}</h3>
        <ul className="divide-y divide-bg-300 border-t border-bg-300">
          {NOTIF_ITEMS.map(({ key, title, desc }) => (
            <li key={key} className="flex items-start justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-100">{g[title] as string}</p>
                <p className="text-[12px] text-text-400 mt-0.5">{g[desc] as string}</p>
              </div>
              <SettingsToggle
                label={g[title] as string}
                checked={prefs.notifications?.[key] ?? NOTIFICATION_DEFAULTS[key as NotificationKind]}
                onChange={(v) => void patch({ notifications: { [key]: v } })}
              />
            </li>
          ))}
          <li className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-100">{g.notifSoundTitle}</p>
              <p className="text-[12px] text-text-400 mt-0.5">{g.notifSoundDesc}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <SettingSelect<string>
                ariaLabel={g.notifSoundTitle}
                value={notificationSound}
                options={NOTIFICATION_SOUND_IDS.map((id) => ({ id, label: g.notifSounds[id] }))}
                onChange={(picked) => {
                  const id = resolveNotificationSound(picked);
                  playNotificationSound(id);
                  void patch({ notificationSound: id });
                }}
              />
              <button
                type="button"
                onClick={() => playNotificationSound(notificationSound)}
                disabled={notificationSound === "none"}
                aria-label={g.notifSoundPreview}
                className="p-2.5 rounded-[8px] bg-bg-200 border border-bg-300 text-text-300 hover:text-text-100 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                <Play className="w-4 h-4" />
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}
