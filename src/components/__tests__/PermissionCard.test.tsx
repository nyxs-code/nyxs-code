// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PermissionCard } from "../PermissionCard";
import { getTranslations } from "@/lib/i18n";

const t = getTranslations("en-US").app;

function card(command: string) {
  return <PermissionCard toolName="Bash" input={{ command }} label="Run a command" queued={0} onRespond={vi.fn()} />;
}

/** The composer, with the caret in it, as when the user is typing the next message. */
function composer() {
  const box = document.createElement("textarea");
  document.body.appendChild(box);
  box.focus();
  return box;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PermissionCard focus", () => {
  it("leaves the caret in the composer, so the next key can't approve", () => {
    const box = composer();
    const { rerender } = render(card("npm test"));
    expect(document.activeElement).toBe(box);
    // The next request mounts a new card (a new key in TurnPrompts).
    rerender(<div key="2">{card("npm run build")}</div>);
    expect(document.activeElement).toBe(box);
  });

  it("leaves it there for a destructive command too", () => {
    const box = composer();
    render(card("rm -rf /"));
    expect(document.activeElement).toBe(box);
  });

  it("focuses Allow once when the user isn't typing", () => {
    render(card("npm test"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.allowOnce }));
  });

  it("focuses Reject for a destructive command", () => {
    render(card("rm -rf /"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.reject }));
  });
});
