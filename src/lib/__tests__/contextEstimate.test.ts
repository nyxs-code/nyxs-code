// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { enrichMeasuredContext, estimateContextBreakdown, estimateProviderContext } from "@/lib/contextEstimate";
import type { ContextBreakdown } from "@/lib/claudeCode";
import type { ModelInfo } from "@/lib/models";

// The panel must not touch disk or the network: the preflight cache and the last MCP read are
// all it gets. These fakes make those caches look populated.
vi.mock("@/lib/preflight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/preflight")>();
  return {
    ...actual,
    cachedPreflight: async () => ({
      skills: [],
      plugins: null,
      agents: [],
      memory: "",
      claudeMemory: "",
      memoryFiles: [
        { name: "/proj/NYXS.md", chars: 400 },
        { name: "/proj/NYXS.local.md", chars: 200 },
      ],
    }),
  };
});

vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return {
    ...actual,
    loadMergedMcpServers: () => [{ id: "mcp-linear", name: "Linear", url: "https://linear.test/mcp", enabled: true }],
    isMcpServerConfigured: () => true,
    cachedMcpTools: () => [
      { id: "mcp__Linear__create_issue", server: "Linear", name: "create_issue", chars: 800 },
      { id: "mcp__Linear__list_issues", server: "Linear", name: "list_issues", chars: 400 },
    ],
  };
});

const usedTokens = (b: ContextBreakdown): number =>
  b.categories.filter((c) => c.kind === "used").reduce((n, c) => n + c.tokens, 0);

const deepseek: ModelInfo = {
  id: "deepseek-v4.1-flash",
  apiModel: "deepseek-v4.1-flash",
  name: "DeepSeek v4.1 Flash",
  description: "",
  provider: "deepseek",
};

describe("estimateContextBreakdown", () => {
  it("makes the used slices add up to the reported total, with the rest as free space", () => {
    const b = estimateContextBreakdown({
      window: 200_000,
      used: 50_000,
      maxOutputTokens: 32_768,
      systemPromptChars: 40_000,
      systemToolChars: 20_000,
      mcpToolChars: 8_000,
      mcpInstructionsChars: 400,
      memoryChars: 12_000,
      skillsChars: 4_000,
      messageTokens: 999_999,
    });

    expect(b.estimated).toBe(true);
    expect(b.maxTokens).toBe(200_000);
    expect(b.totalTokens).toBe(50_000);
    // The conversation is derived from the reported total, not from the (stale) history.
    expect(b.categories.find((c) => c.name === "Messages")?.tokens).toBe(28_900);
    expect(usedTokens(b)).toBe(50_000);
    const buffer = b.categories.find((c) => c.kind === "buffer");
    expect(buffer?.tokens).toBe(40_000);
    expect(usedTokens(b) + (buffer?.tokens ?? 0)).toBeLessThanOrEqual(b.maxTokens);
  });

  it("scales the overhead down when the provider counted less than it estimates", () => {
    const b = estimateContextBreakdown({
      window: 200_000,
      used: 1_000,
      maxOutputTokens: 32_768,
      systemPromptChars: 400_000,
      systemToolChars: 80_000,
      mcpToolChars: 40_000,
      mcpInstructionsChars: 4_000,
      memoryChars: 40_000,
      skillsChars: 20_000,
      messageTokens: 0,
    });

    expect(b.totalTokens).toBe(1_000);
    expect(usedTokens(b)).toBeLessThanOrEqual(1_000);
    expect(usedTokens(b)).toBeGreaterThan(0);
  });

  it("lists per-tool and per-file rows that add up to their slice, with deferred rows outside it", () => {
    const b = estimateContextBreakdown({
      window: 200_000,
      used: 0,
      maxOutputTokens: 32_768,
      systemPromptChars: 1_000,
      systemTools: [
        { name: "Read", chars: 400 },
        { name: "Bash", chars: 800 },
      ],
      deferredSystemTools: [{ name: "GitLog", chars: 200 }],
      mcpTools: [{ name: "Linear · create_issue", chars: 600 }],
      deferredMcpTools: [{ name: "Higgsfield · add_ads", chars: 300 }],
      mcpInstructionsChars: 100,
      memoryFiles: [
        { name: "/proj/NYXS.md", chars: 900 },
        { name: "/proj/NYXS.local.md", chars: 300 },
      ],
      skillsChars: 0,
      messageTokens: 0,
    });

    const category = (id: string) => b.categories.find((c) => c.id === id)!;
    const childTokens = (id: string) => category(id).children!.reduce((n, child) => n + child.tokens, 0);
    expect(childTokens("system-tools")).toBe(category("system-tools").tokens);
    expect(childTokens("mcp-tools")).toBe(category("mcp-tools").tokens);
    expect(childTokens("memory-files")).toBe(category("memory-files").tokens);
    expect(category("mcp-tools").children!.map((child) => child.name)).toEqual(["Linear · create_issue"]);
    expect(category("memory-files").children!.map((child) => child.name)).toEqual([
      "/proj/NYXS.md",
      "/proj/NYXS.local.md",
    ]);

    const deferred = b.categories.filter((c) => c.kind === "deferred");
    expect(deferred.map((c) => c.id)).toEqual(["system-tools-deferred", "mcp-tools-deferred"]);
    expect(deferred.reduce((n, c) => n + c.tokens, 0)).toBeGreaterThan(0);
    // Deferred schemas are only listed: they don't count as used nor change the total.
    expect(b.totalTokens).toBe(usedTokens(b));
    expect(deferred.some((c) => usedTokens({ ...b, categories: [c] }) > 0)).toBe(false);
  });

  it("estimates the conversation from the history when there is no reported total yet", () => {
    const b = estimateContextBreakdown({
      window: 200_000,
      used: 0,
      maxOutputTokens: 32_768,
      systemPromptChars: 20_000,
      systemToolChars: 8_000,
      mcpToolChars: 0,
      mcpInstructionsChars: 0,
      memoryChars: 0,
      skillsChars: 0,
      messageTokens: 1_234,
    });

    expect(b.totalTokens).toBe(usedTokens(b));
    expect(b.totalTokens).toBe(7_000 + 1_234);
    expect(b.categories.find((c) => c.name === "Messages")?.tokens).toBe(1_234);
  });
});

describe("estimateProviderContext", () => {
  it("gives a provider that isn't Claude Code a breakdown without opening any process", async () => {
    const b = await estimateProviderContext({
      model: deepseek,
      workspace: null,
      used: 0,
      messages: [{ id: "u1", role: "user", content: "hola" }],
    });

    expect(b.estimated).toBe(true);
    expect(b.maxTokens).toBe(200_000);
    expect(b.categories.some((c) => c.name === "System prompt" && c.tokens > 0)).toBe(true);
    expect(b.categories.find((c) => c.name === "Messages")?.tokens).toBeGreaterThan(0);
    expect(usedTokens(b)).toBe(b.totalTokens);
  });

  it("gives a provider per-tool and per-file rows from the cached preflight and MCP read", async () => {
    const b = await estimateProviderContext({
      model: deepseek,
      workspace: "/proj",
      used: 50_000,
      messages: [],
    });

    const category = (id: string) => b.categories.find((c) => c.id === id)!;
    const childTokens = (id: string) => category(id).children!.reduce((n, child) => n + child.tokens, 0);
    for (const id of ["system-tools", "mcp-tools", "memory-files"]) {
      expect(category(id).children!.length).toBeGreaterThan(0);
      expect(childTokens(id)).toBe(category(id).tokens);
    }
    expect(category("mcp-tools").children!.map((child) => child.name)).toEqual([
      "Linear · create_issue",
      "Linear · list_issues",
    ]);
    expect(category("memory-files").children!.map((child) => child.name)).toEqual([
      "/proj/NYXS.md",
      "/proj/NYXS.local.md",
    ]);
    expect(b.categories.some((c) => c.kind === "deferred")).toBe(true);
    expect(usedTokens(b)).toBe(b.totalTokens);
  });

  it("keeps Claude Code's measured numbers and only fills in the rows it lacks", async () => {
    const measured: ContextBreakdown = {
      categories: [
        { id: "system-tools", name: "System tools", tokens: 500, kind: "used" },
        { id: "mcp-tools", name: "MCP tools", tokens: 300, kind: "used" },
        { id: "memory-files", name: "Memory files", tokens: 100, kind: "used" },
      ],
      totalTokens: 900,
      maxTokens: 200_000,
    };

    const b = await enrichMeasuredContext(measured, { model: deepseek, workspace: "/proj" });

    expect(b.totalTokens).toBe(900);
    expect(b.maxTokens).toBe(200_000);
    expect(b.estimated).toBeUndefined();
    const category = (id: string) => b.categories.find((c) => c.id === id)!;
    expect(category("system-tools").tokens).toBe(500);
    expect(category("system-tools").children!.reduce((n, c) => n + c.tokens, 0)).toBe(500);
    expect(category("system-tools").childrenEstimated).toBe(true);
    expect(category("mcp-tools").children!.map((c) => c.name)).toContain("Linear · create_issue");
    expect(category("mcp-tools").children!.reduce((n, c) => n + c.tokens, 0)).toBe(300);
    expect(category("memory-files").children!.reduce((n, c) => n + c.tokens, 0)).toBe(100);
    expect(b.categories.find((c) => c.id === "system-tools-deferred")?.kind).toBe("deferred");
  });
});
