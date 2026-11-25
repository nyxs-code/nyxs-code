// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ToolChip } from "@/components/message/ToolChips";
import { deliveryMarker, markRead, markReplied, noteDelivery, resetDeliveriesForTests } from "@/lib/sessionDelivery";
import { getTranslations } from "@/lib/i18n";

const t = getTranslations("en-US").message;
afterEach(() => {
  cleanup();
  resetDeliveriesForTests();
});

it("a message sent to another session shows where it is, as it changes", () => {
  noteDelivery("m1", "here", "other", true);
  const output = `Queued for other: a turn is running there, and the message goes in when it ends. ${deliveryMarker("m1")}`;
  render(<ToolChip name="SendToSession" detail="other" end={{ status: "ok" }} streaming={false} info={{ name: "SendToSession", detail: "other", output }} />);
  expect(screen.getByText(`· ${t.deliveryQueued}`)).toBeTruthy();
  act(() => markRead(["m1"]));
  expect(screen.getByText(`· ${t.deliveryRead}`)).toBeTruthy();
  act(() => markReplied("other", "here"));
  expect(screen.getByText(`· ${t.deliveryReplied}`)).toBeTruthy();
});
