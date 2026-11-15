// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentActivityLog } from "@/components/AgentActivityLog";
import { ToolChip } from "@/components/message/ToolChips";
import { parseMessage, toolCompleted } from "@/components/message/parse";
import { appendActivity, settleActivity } from "@/lib/agentActivity";
import { interruptedReply } from "@/lib/chatMessages";
import { getLanguage, getTranslations } from "@/lib/i18n";
import { closeOpenTools } from "@/lib/toolMarkers";

afterEach(cleanup);

const tr = getTranslations(getLanguage());

describe("a tool cut off by a stop", () => {
  it("settles as stopped in a sub-agent's activity, with its own label", () => {
    let list = appendActivity([], { kind: "tool-call", callId: "a", name: "Read", detail: "x.ts" });
    list = appendActivity(list, { kind: "tool-call", callId: "b", name: "Grep", detail: "foo" });
    list = appendActivity(list, { kind: "tool-result", callId: "a", ok: false });
    list = settleActivity(list);
    expect(list.map((e) => e.kind === "tool" && e.status)).toEqual(["error", "stopped"]);
    render(<AgentActivityLog activity={list} running={false} />);
    expect(screen.getByRole("img", { name: tr.workflowProgress.toolFailed })).toBeTruthy();
    expect(screen.getByRole("img", { name: tr.workflowProgress.toolStopped })).toBeTruthy();
  });

  it("closes the chat's open tool cards as stopped when the reply is stopped", () => {
    const content = "⟦TOOL⟧t1⟦SEP⟧Read⟦SEP⟧a.ts⟦/TOOL⟧⟦TOOLEND⟧t1⟦SEP⟧ok⟦/TOOLEND⟧⟦TOOL⟧t2⟦SEP⟧Bash⟦SEP⟧npm test⟦/TOOL⟧";
    expect(closeOpenTools(closeOpenTools(content))).toBe(`${content}⟦TOOLEND⟧t2⟦SEP⟧stop⟦/TOOLEND⟧`);
    const stopped = interruptedReply({ id: "m", role: "assistant", content, streaming: true } as never);
    const { endMap } = parseMessage(stopped.content);
    expect(endMap.get("t1")).toEqual({ status: "ok" });
    expect(endMap.get("t2")).toEqual({ status: "stopped" });
    expect([toolCompleted(endMap.get("t1")), toolCompleted(endMap.get("t2")), toolCompleted({ status: "err", message: "x" })]).toEqual([true, false, false]);
  });

  it("shows its card as stopped, not failed and not done", () => {
    render(<ToolChip name="Bash" detail="npm test" end={{ status: "stopped" }} streaming={false} info={undefined} />);
    expect(screen.getByText(`· ${tr.message.toolStopped}`)).toBeTruthy();
    expect(screen.queryByText(tr.toolVerbs.Bash?.[1] ?? "\u0000")).toBeNull();
  });
});
