import type { ReactNode } from "react";
import { X, Info, AlertTriangle } from "lucide-react";

export interface NoticeCardProps {
  tone: "warning" | "info";
  title: ReactNode;
  body?: ReactNode;
  /** A button under the text. */
  action?: ReactNode;
  closeLabel: string;
  onClose: () => void;
}

/** The bottom-right card of the app's notices (announcements, files it couldn't read). Its
 *  place on screen is CornerNotices'. */
export function NoticeCard({ tone, title, body, action, closeLabel, onClose }: NoticeCardProps) {
  const warning = tone === "warning";
  return (
    <div role={warning ? "alert" : "status"} className="flex gap-3 rounded-[8px] border border-bg-300 bg-bg-100 p-3.5 shadow-2xl animate-fade-in">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          warning ? "bg-amber-500/15 text-amber-400" : "bg-sky-500/15 text-sky-400"
        }`}
      >
        {warning ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{title}</p>
        {body && <p className="mt-0.5 text-[13px] leading-snug text-text-300">{body}</p>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
      <button
        onClick={onClose}
        className="-mr-1 -mt-1 h-6 w-6 shrink-0 rounded-md text-text-400 hover:bg-bg-200 hover:text-text-200 transition-colors flex items-center justify-center"
        aria-label={closeLabel}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
