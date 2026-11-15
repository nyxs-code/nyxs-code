import { describe, expect, it } from "vitest";
import { classifyAddress, findProjectFile } from "../addressInput";
import { buildAddressSuggestions, wantsWebSuggestions } from "../addressSuggestions";
import { isValidSearchTemplate, parseSuggestions, searchEngineName, searchUrl, suggestionsUrl } from "@/lib/searchEngines";

const FILES = ["src/app.ts", "README.md", "docs/README.md", "package.json", "LICENSE", "docs/guide/setup.md"];

describe("classifyAddress", () => {
  it("reads addresses, searches and paths the way a browser's address bar does", () => {
    expect(classifyAddress("https://example.com/a")).toEqual({ kind: "web", url: "https://example.com/a" });
    expect(classifyAddress("localhost:5173/app")).toEqual({ kind: "web", url: "http://localhost:5173/app" });
    expect(classifyAddress("127.0.0.1:8080")).toEqual({ kind: "web", url: "http://127.0.0.1:8080" });
    expect(classifyAddress("example.com")).toEqual({ kind: "web", url: "https://example.com" });
    expect(classifyAddress("react hooks")).toEqual({ kind: "search", query: "react hooks" });
    expect(classifyAddress("vite")).toEqual({ kind: "search", query: "vite" });
    expect(classifyAddress("C:\\site\\index.html")).toEqual({ kind: "path", path: "C:\\site\\index.html" });
    expect(classifyAddress("dist/index.html")).toEqual({ kind: "path", path: "dist/index.html" });
    expect(classifyAddress("./notes")).toEqual({ kind: "path", path: "./notes" });
    expect(classifyAddress("open docs/guide/setup.md")).toEqual({ kind: "path", path: "open docs/guide/setup.md" });
  });

  it("opens a project file a single word names, with or without its extension", () => {
    expect(classifyAddress("README", FILES)).toEqual({ kind: "path", path: "README.md" });
    expect(classifyAddress("readme", FILES)).toEqual({ kind: "path", path: "README.md" });
    expect(classifyAddress("LICENSE", FILES)).toEqual({ kind: "path", path: "LICENSE" });
    // A dotted name is a file before it is a website.
    expect(classifyAddress("package.json", FILES)).toEqual({ kind: "path", path: "package.json" });
    expect(classifyAddress("setup", FILES)).toEqual({ kind: "path", path: "docs/guide/setup.md" });
    // Not a file of the project: still a search, or a website.
    expect(classifyAddress("vite", FILES)).toEqual({ kind: "search", query: "vite" });
    expect(classifyAddress("example.com", FILES)).toEqual({ kind: "web", url: "https://example.com" });
    // Phrases and local servers never look for a file.
    expect(classifyAddress("readme file", FILES)).toEqual({ kind: "search", query: "readme file" });
    expect(classifyAddress("localhost", ["localhost.txt"])).toEqual({ kind: "web", url: "http://localhost" });
  });

  it("finds the file nearest the project's root, by path, name or stem", () => {
    expect(findProjectFile("README", FILES)).toBe("README.md");
    expect(findProjectFile("docs/README.md", FILES)).toBe("docs/README.md");
    expect(findProjectFile("docs\\README.md", FILES)).toBe("docs/README.md");
    expect(findProjectFile("app.ts", FILES)).toBe("src/app.ts");
    // A name with an extension has to match it whole; a missing folder isn't guessed.
    expect(findProjectFile("app.js", FILES)).toBeUndefined();
    expect(findProjectFile("lib/app.ts", FILES)).toBeUndefined();
    expect(findProjectFile("", FILES)).toBeUndefined();
  });
});

describe("search engines", () => {
  it("builds the search address for each engine, Google by default", () => {
    expect(searchUrl("a b&c")).toBe("https://www.google.com/search?q=a%20b%26c");
    expect(searchUrl("x", { engine: "duckduckgo" })).toBe("https://duckduckgo.com/?q=x");
    expect(searchUrl("x", { engine: "bing" })).toBe("https://www.bing.com/search?q=x");
    expect(searchUrl("x", { engine: "brave" })).toBe("https://search.brave.com/search?q=x");
    expect(searchUrl("x", { engine: "nope" })).toBe("https://www.google.com/search?q=x");
    expect(searchEngineName({ engine: "brave" })).toBe("Brave Search");
  });

  it("uses a custom address only when it is valid", () => {
    const custom = { engine: "custom", customUrl: "https://kagi.com/search?q=%s" };
    expect(searchUrl("rust", custom)).toBe("https://kagi.com/search?q=rust");
    expect(searchEngineName(custom)).toBe("kagi.com");
    expect(isValidSearchTemplate("https://kagi.com/search?q=")).toBe(false);
    expect(isValidSearchTemplate("kagi.com/search?q=%s")).toBe(false);
    expect(searchUrl("rust", { engine: "custom", customUrl: "not a url %s" })).toBe("https://www.google.com/search?q=rust");
  });
});

describe("search suggestions", () => {
  it("asks each engine's suggestions endpoint, and none for a custom engine", () => {
    expect(suggestionsUrl("a b")).toBe("https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=a%20b");
    expect(suggestionsUrl("x", { engine: "duckduckgo" })).toBe("https://duckduckgo.com/ac/?type=list&q=x");
    expect(suggestionsUrl("x", { engine: "bing" })).toBe("https://api.bing.com/osjson.aspx?query=x");
    expect(suggestionsUrl("x", { engine: "brave" })).toBe("https://search.brave.com/api/suggest?q=x");
    expect(suggestionsUrl("x", { engine: "custom", customUrl: "https://kagi.com/search?q=%s" })).toBeUndefined();
  });

  it("uses a custom engine's own suggestions address only when it is valid", () => {
    const custom = { engine: "custom", customUrl: "https://kagi.com/search?q=%s" };
    expect(suggestionsUrl("a b", { ...custom, customSuggestUrl: "https://kagi.com/api/autosuggest?q=%s" })).toBe(
      "https://kagi.com/api/autosuggest?q=a%20b",
    );
    // Without one, or with garbage, nothing is asked and the words don't go to Google.
    expect(suggestionsUrl("x", { ...custom, customSuggestUrl: "" })).toBeUndefined();
    expect(suggestionsUrl("x", { ...custom, customSuggestUrl: "https://kagi.com/api/autosuggest?q=" })).toBeUndefined();
    expect(suggestionsUrl("x", { ...custom, customSuggestUrl: "kagi.com/api/autosuggest?q=%s" })).toBeUndefined();
  });

  it("reads the words of an OpenSearch answer and nothing else", () => {
    expect(parseSuggestions(["rea", ["react", "react hooks", 3, ""]])).toEqual(["react", "react hooks"]);
    expect(parseSuggestions({ q: "rea" })).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
  });

  it("never sends a path or an address on this machine or its network", () => {
    expect(wantsWebSuggestions("react hooks")).toBe(true);
    expect(wantsWebSuggestions("github.com")).toBe(true);
    expect(wantsWebSuggestions("")).toBe(false);
    expect(wantsWebSuggestions("localhost:3001/dashboard")).toBe(false);
    expect(wantsWebSuggestions("192.168.1.20:8080")).toBe(false);
    expect(wantsWebSuggestions("http://app.local")).toBe(false);
    expect(wantsWebSuggestions("C:\\site\\index.html")).toBe(false);
    expect(wantsWebSuggestions("dist/index.html")).toBe(false);
  });
});

describe("buildAddressSuggestions", () => {
  it("puts the search for what was typed first, then the engine's suggestions, each once", () => {
    const list = buildAddressSuggestions("react", ["react", "React hooks", "react hooks", "react native"], "Google");
    expect(list).toEqual([
      { kind: "search", value: "react", label: "react", detail: "Google" },
      { kind: "suggestion", value: "React hooks", label: "React hooks" },
      { kind: "suggestion", value: "react native", label: "react native" },
    ]);
  });

  it("offers going to an address that was typed instead of searching it", () => {
    expect(buildAddressSuggestions("https://www.github.com/", [], "Google")).toEqual([
      { kind: "address", value: "https://www.github.com/", label: "github.com" },
    ]);
    expect(buildAddressSuggestions("localhost:3001", [], "Google")[0]).toMatchObject({ kind: "address", label: "localhost:3001" });
  });

  it("shows nothing with nothing typed, and keeps the list short", () => {
    expect(buildAddressSuggestions("  ", ["x"], "Google")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `site ${i}`);
    expect(buildAddressSuggestions("site", many, "Google")).toHaveLength(8);
  });
});
