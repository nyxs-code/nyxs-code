// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls: Array<[string, Record<string, unknown> | undefined]> = [];
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === "browser_cookie_sources")
      return [
        { id: "firefox:/p/cookies.sqlite", browser: "firefox", profile: "", supported: true },
        { id: "chrome:unreadable", browser: "chrome", profile: "", supported: false },
      ];
    if (cmd === "browser_cookie_sites")
      return [
        { site: "github.com", cookies: 14 },
        { site: "bbva.es", cookies: 11 },
        { site: "linear.app", cookies: 1 },
      ];
    if (cmd === "browser_cookie_import") return { sites: 2, cookies: 15, failed: 0 };
    return null;
  }),
}));

import { CookieImportDialog } from "@/components/views/preview/CookieImportDialog";
import { isFinancialSite } from "@/lib/financialSites";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(() => {
  cleanup();
  calls.length = 0;
});
const t = getTranslations(getLanguage()).cookieImport;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("importing cookies from another browser", () => {
  it("offers the readable browsers, leaves financial sites unticked, and imports the chosen ones", async () => {
    const onReload = vi.fn();
    render(<CookieImportDialog profile="shared" onClose={() => {}} onReload={onReload} />);
    await flush();
    await flush();
    expect(screen.getByRole("radio", { name: "Firefox" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Chrome/ })).toHaveProperty("disabled", true);
    expect(screen.getByText(t.onlyFirefox)).toBeTruthy();
    const box = (site: string) => screen.getByText(site).closest("label")!.querySelector("input")!;
    expect(box("github.com").checked).toBe(true);
    expect(box("bbva.es").checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: t.importMany.replace("{count}", "2") }));
    await flush();
    const imported = calls.find(([c]) => c === "browser_cookie_import")?.[1];
    expect(imported).toEqual({ source: "firefox:/p/cookies.sqlite", sites: ["github.com", "linear.app"], keep: false, profile: "shared" });
    expect(screen.getByText(t.doneMany.replace("{count}", "2"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.reloadPage }));
    expect(onReload).toHaveBeenCalled();
  });

  it("can't import into the profile that keeps nothing", async () => {
    render(<CookieImportDialog profile="private" onClose={() => {}} />);
    await flush();
    await flush();
    expect(screen.getByText(t.privateProfile)).toBeTruthy();
    expect(screen.getByRole("button", { name: t.importMany.replace("{count}", "2") })).toHaveProperty("disabled", true);
  });

  it("knows banks and payment sites", () => {
    expect(isFinancialSite("bbva.es")).toBe(true);
    expect(isFinancialSite("paypal.com")).toBe(true);
    expect(isFinancialSite("github.com")).toBe(false);
  });
});
