// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const answers = new Map<string, (entries: unknown[]) => void>();
vi.mock("@/lib/skillsSh", async (orig) => ({
  ...(await orig<typeof import("@/lib/skillsSh")>()),
  browseSkills: ({ query }: { query: string }) => new Promise((resolve) => answers.set(query, resolve)),
}));
vi.mock("@/lib/skills", async (orig) => ({ ...(await orig<typeof import("@/lib/skills")>()), loadSkills: async () => [] }));

const { SkillsDirectory } = await import("@/components/SkillsDirectory");
const { getTranslations } = await import("@/lib/i18n");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const entry = (name: string) => ({ id: name, slug: name, name, source: "x/y", description: `${name} skill`, sourceType: "github", installUrl: null, url: "" });

describe("searching the skills catalog", () => {
  it("shows the latest search's results even when an earlier search answers last", async () => {
    vi.useFakeTimers();
    const view = render(<SkillsDirectory workspace={null} />);
    const box = view.getByPlaceholderText(getTranslations("en-US").directory.searchPlaceholder);
    fireEvent.change(box, { target: { value: "re" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    fireEvent.change(box, { target: { value: "react" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => answers.get("react")?.([entry("react-pro")]));
    await act(async () => answers.get("re")?.([entry("regex-helper")]));
    expect(view.queryByText("react-pro")).not.toBeNull();
    expect(view.queryByText("regex-helper")).toBeNull();
  });
});
