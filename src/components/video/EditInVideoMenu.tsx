import { useEffect, useRef } from "react";
import { Clapperboard } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { requestEditVideoFile } from "./editVideoFile";

/** The right-click menu of a video file in the Files panel. */
export function EditInVideoMenu({ x, y, path, onClose }: { x: number; y: number; path: string; onClose: () => void }) {
  const t = useTranslations().videoPanel;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" data-webview-hole className="fixed z-[70] w-48 rounded-[5px] border border-bg-300 bg-bg-100 p-1 shadow-lg" style={{ left: x, top: y }}>
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={() => {
          onClose();
          requestEditVideoFile(path);
        }}
        className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1 text-left text-[13px] text-text-100 hover:bg-bg-200"
      >
        <Clapperboard className="h-4 w-4 shrink-0 text-text-300" />
        <span className="truncate">{t.editInVideo}</span>
      </button>
    </div>
  );
}
