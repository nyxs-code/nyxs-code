import { useTranslations } from "@/lib/i18n";
import { liftMemoryLimit, useMemoryLimitLifted } from "@/lib/commandMemory";
import { useCommandRunEnv } from "./commandRun";

/**
 * Under a command Nyxs stopped for its memory, as Claude Code Desktop has it: a quiet line in
 * the conversation saying how much it used on how much the computer has, with "Allow in this
 * session". Once allowed, the line says so and the link goes.
 */
export function MemoryStopNote({ usedGb, installedGb }: { usedGb: number; installedGb: number }) {
  const t = useTranslations().commandMemory;
  const { chatId } = useCommandRunEnv();
  const lifted = useMemoryLimitLifted(chatId);
  const stopped = t.stopped.replace("{used}", String(usedGb)).replace("{installed}", String(installedGb));
  return (
    <p role="status" className="mt-0.5 mb-1 text-[12.5px] leading-[19px] text-text-400">
      {stopped}
      {lifted ? (
        <> {t.lifted}</>
      ) : chatId ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={() => liftMemoryLimit(chatId)}
            className="text-text-300 underline decoration-text-500 underline-offset-2 hover:text-text-100"
          >
            {t.allow}
          </button>
        </>
      ) : null}
    </p>
  );
}
