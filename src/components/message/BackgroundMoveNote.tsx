import { useTranslations } from "@/lib/i18n";
import { focusBackgroundTask } from "@/components/views/bgFocus";
import { useCommandRunEnv } from "./commandRun";

/** Under a moved command: where it goes on, with a link to it in Background tasks. */
export function BackgroundMoveNote({ shellId, title }: { shellId: string; title: string }) {
  const t = useTranslations().commandBackground;
  const { openView } = useCommandRunEnv();
  const [before, after = ""] = t.stillIn.split("{link}");
  return (
    <p className="mt-0.5 mb-1 text-[12.5px] leading-[19px] text-text-400">
      {before}
      <button
        type="button"
        onClick={() => {
          focusBackgroundTask(shellId, title);
          openView?.("background");
        }}
        className="text-text-300 underline decoration-text-500 underline-offset-2 hover:text-text-100"
      >
        {t.tasksLink}
      </button>
      {after}
    </p>
  );
}
