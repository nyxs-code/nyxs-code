import { test, expect } from "../fixtures";

test.describe("Built-in browser address bar", () => {
  test.beforeEach(async ({ page, app }) => {
    await app({ files: { "README.md": "# Hola\n", "src/app.ts": "export {};\n" } });
    await page.getByRole("button", { name: "Browser", exact: true }).click();
  });

  test("offers what was typed, never history or project files, and opens the one picked", async ({ page }) => {
    const address = page.getByRole("combobox", { name: "Search Google or type a URL" });
    await address.fill("example.com/docs");
    await address.press("Enter");
    await expect(address).toHaveValue("example.com/docs");

    await address.fill("READ");
    const list = page.getByRole("listbox", { name: "Suggestions" });
    // README.md is in the project, but a browser's list offers searches, not files.
    await expect(list.getByRole("option")).toHaveText(["Search Google for “READ”"]);

    // The page just opened isn't offered back: suggestions come from the search engine
    // (unreachable here), not from this machine's history.
    await address.fill("exam");
    await expect(list.getByRole("option")).toHaveText(["Search Google for “exam”"]);

    // An address typed is offered as itself, to go there.
    await address.fill("https://www.example.org/");
    await expect(list.getByRole("option")).toHaveText(["example.org"]);
    await address.press("ArrowDown");
    await expect(list.getByRole("option", { name: "example.org" })).toHaveAttribute("aria-selected", "true");
    await address.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(address).toHaveValue("www.example.org");
  });

  test("opens a project file named by a single word instead of searching it", async ({ page }) => {
    const address = page.getByRole("combobox", { name: "Search Google or type a URL" });
    await address.fill("README");
    await address.press("Enter");
    await expect(address).toHaveValue("README.md");

    await address.fill("hello world");
    await address.press("Enter");
    await expect(address).toHaveValue("www.google.com/search?q=hello%20world");
  });

  test("Escape closes the list first and keeps what was typed", async ({ page }) => {
    const address = page.getByRole("combobox", { name: "Search Google or type a URL" });
    await address.fill("app");
    const list = page.getByRole("listbox", { name: "Suggestions" });
    await expect(list).toBeVisible();
    await address.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(address).toBeFocused();
    await expect(address).toHaveValue("app");
  });
});
