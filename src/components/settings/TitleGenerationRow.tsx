import { useState } from "react";
import { useTranslations } from "@/lib/i18n";
import { useSettings } from "@/lib/useSettings";
import { resolveTitleGenerator, testTitle, TITLE_GENERATORS, type TitleGenerator } from "@/lib/titles";
import { SettingSelect } from "./SettingSelect";

type Test = { state: "idle" } | { state: "running" } | { state: "done"; text: string } | { state: "failed"; text: string };

/** Settings › General › "Title generation": who names new sessions, and a test that shows a title. */
export function TitleGenerationRow() {
  const g = useTranslations().settings.generalPage;
  const { settings, update } = useSettings();
  const value = resolveTitleGenerator((settings as { titleGeneration?: unknown }).titleGeneration);
  const [test, setTest] = useState<Test>({ state: "idle" });

  const run = async (generator: TitleGenerator) => {
    setTest({ state: "running" });
    try {
      const title = await testTitle(generator, g.titleGenSample);
      setTest({ state: "done", text: g.titleGenResult.replace("{title}", title) });
    } catch (e) {
      setTest({ state: "failed", text: g.titleGenFailed.replace("{error}", e instanceof Error ? e.message : String(e)) });
    }
  };

  const line = test.state === "running" ? g.titleGenTesting : test.state === "done" || test.state === "failed" ? test.text : g.titleGenDesc;
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-100">{g.titleGenTitle}</p>
        <p className={`text-[12px] mt-0.5 truncate ${test.state === "failed" ? "text-danger" : "text-text-400"}`} aria-live="polite">
          {line}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <SettingSelect<TitleGenerator>
          ariaLabel={g.titleGenTitle}
          value={value}
          options={TITLE_GENERATORS.map((id) => ({ id, label: g.titleGenOptions[id] }))}
          onChange={(id) => {
            update({ titleGeneration: id } as Parameters<typeof update>[0], "user");
            setTest({ state: "idle" });
          }}
        />
        <button
          type="button"
          onClick={() => void run(value)}
          disabled={test.state === "running" || value === "off"}
          className="h-8 px-3 rounded-md bg-bg-200 text-[13px] text-text-100 hover:bg-bg-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          {g.titleGenTest}
        </button>
      </div>
    </div>
  );
}
