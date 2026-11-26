import { describe, expect, it } from "vitest";
import { oauthScopesFor } from "@/lib/mcpOAuth";
import { CONNECTOR_CATALOG } from "@/lib/mcp";

// What gmailmcp.googleapis.com publishes in its protected resource metadata (part of it).
const GMAIL_SERVER_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

describe("the scopes a connector signs in with", () => {
  it("are the ones it chose, not every scope its server accepts", () => {
    const gmail = CONNECTOR_CATALOG.find((c) => c.name === "Gmail")!;
    const scopes = oauthScopesFor(gmail.oauthScopes, { resourceScopes: GMAIL_SERVER_SCOPES });
    expect(scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(scopes).not.toContain("https://mail.google.com/");
  });

  it("fall back to what the server publishes for a connector that chose none", () => {
    expect(oauthScopesFor(undefined, { resourceScopes: ["a"], scopes_supported: ["b"] })).toEqual(["a"]);
    expect(oauthScopesFor([], { scopes_supported: ["b"] })).toEqual(["b"]);
    expect(oauthScopesFor(undefined, {})).toBeUndefined();
  });
});
