import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  checked,
  right,
  onHover,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A toggle: shows the check while on. */
  checked?: boolean;
  right?: ReactNode;
  onHover?: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        "flex items-center gap-2 w-full text-left px-2 py-1 rounded-[5px] text-[13px] transition-colors disabled:opacity-40 disabled:pointer-events-none",
        danger ? "text-red-600 dark:text-red-400 hover:bg-red-500/10" : "text-text-100 hover:bg-bg-200",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right}
      {checked && <Check className="w-4 h-4 shrink-0 text-accent" />}
    </button>
  );
}

export const MenuSep = () => <div className="my-1 mx-1 border-t border-bg-300" />;
