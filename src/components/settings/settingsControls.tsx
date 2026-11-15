import { type ReactNode } from "react";
import { useTranslations } from "@/lib/i18n";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-semibold text-text-100 mb-4">{children}</h2>;
}

export function SettingsToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-bg-300"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

function ComingSoonBadge() {
  const cs = useTranslations().codeSettings;
  return (
    <span className="shrink-0 rounded-md bg-bg-200 border border-bg-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-400">
      {cs.comingSoon}
    </span>
  );
}

export function SettingRow({
  title,
  desc,
  soon,
  children,
}: {
  title: string;
  desc?: string;
  soon?: boolean;
  children?: ReactNode;
}) {
  if (!desc) {
    return (
      <div className={`flex items-center justify-between gap-4 py-3.5 ${soon ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <p className="text-sm font-medium text-text-100">{title}</p>
          {soon && <ComingSoonBadge />}
        </div>
        {children && <div className="shrink-0">{children}</div>}
      </div>
    );
  }
  return (
    <div className={`py-3.5 ${soon ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-text-100">{title}</p>
        {soon && <ComingSoonBadge />}
      </div>
      <div className="flex items-start justify-between gap-4 mt-0.5">
        <p className="text-[12px] text-text-400 min-w-0 flex-1">{desc}</p>
        {children && <div className="shrink-0 flex items-center h-4">{children}</div>}
      </div>
    </div>
  );
}

/** A settings row whose control (a dropdown) sits beside the title and description, centered on both. */
export function SelectRow({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{title}</p>
        <p className="text-[12px] text-text-400 mt-0.5">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-base font-semibold text-text-100 mb-1">{title}</h3>
      <div className="divide-y divide-bg-300 border-t border-bg-300">{children}</div>
    </section>
  );
}

export function DisabledToggle() {
  return (
    <div className="relative w-10 h-6 shrink-0 rounded-full bg-bg-300 opacity-50" aria-hidden>
      <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white/70" />
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-200 border border-bg-300">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${active ? "bg-bg-0 text-text-100 shadow-sm" : "text-text-400 hover:text-text-200"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Placeholder({ label }: { label: string }) {
  const t = useTranslations().settings;
  return (
    <div>
      <SectionTitle>{label}</SectionTitle>
      <p className="text-sm text-text-400">{t.comingSoon}</p>
    </div>
  );
}
