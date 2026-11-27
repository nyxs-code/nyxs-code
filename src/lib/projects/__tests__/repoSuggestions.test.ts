import { describe, expect, it, vi } from "vitest";

const remotes: Record<string, string> = {
  "C:\\a": "git@github.com:me/shop.git\n",
  "C:\\b": "https://github.com/Me/Shop\n",
  "C:\\c": "https://gitlab.com/me/other.git\n",
  "C:\\d": "https://github.com/me/api.git\n",
};
vi.mock("@/lib/gitErrors", () => ({
  runGit: async (cwd: string) => (remotes[cwd] ? { code: 0, stdout: remotes[cwd], stderr: "" } : { code: 2, stdout: "", stderr: "no remote" }),
}));

const { githubRepoOf, repoLabel, repoUrlOf, suggestedRepos } = await import("../repoSuggestions");

describe("repositories in the project dialog", () => {
  it("reads owner/repo from remotes, URLs and what the user types", () => {
    expect(githubRepoOf("git@github.com:me/shop.git")).toBe("me/shop");
    expect(githubRepoOf("https://github.com/me/shop/")).toBe("me/shop");
    expect(githubRepoOf(" me/shop ")).toBe("me/shop");
    expect(githubRepoOf("https://gitlab.com/me/shop")).toBeNull();
    expect(githubRepoOf("shop")).toBeNull();
    expect(repoUrlOf("me/shop")).toBe("https://github.com/me/shop");
    expect(repoUrlOf("https://gitlab.com/me/shop.git")).toBe("https://gitlab.com/me/shop.git");
    expect(repoUrlOf("not a repo")).toBeNull();
    expect(repoLabel("https://github.com/me/shop")).toBe("me/shop");
    expect(repoLabel("https://gitlab.com/me/shop.git")).toBe("gitlab.com/me/shop");
  });

  it("suggests the GitHub origins of recent folders, once each, skipping remote ones", async () => {
    expect(await suggestedRepos(["C:\\a", "C:\\b", "ssh://box/x", "C:\\c", "C:\\none", "C:\\d"])).toEqual(["me/shop", "me/api"]);
    expect(await suggestedRepos(["C:\\a", "C:\\d"], 1)).toEqual(["me/shop"]);
  });
});
