// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorDetail } from "@/components/customize/ConnectorDetail";
import type { Connectors } from "@/components/customize/useConnectors";
import { CONNECTOR_CATALOG } from "@/lib/mcp";
import { getTranslations } from "@/lib/i18n";

vi.mock("@/lib/secureStore", () => ({ getSecret: async () => null, setSecret: async () => {} }));

const t = getTranslations("en-US").customizePage;
const gmail = CONNECTOR_CATALOG.find((c) => c.name === "Gmail")!;
// The same connector without and with Nyxs's own client, whatever the build's environment holds.
const withoutClient = { ...gmail, oauthClientId: "", oauthClientSecret: "" };
const withClient = { ...gmail, oauthClientId: "nyxs.apps.googleusercontent.com", oauthClientSecret: "secret" };
afterEach(cleanup);

function setup(entry = gmail) {
  const connectors = {
    serverFor: () => undefined,
    statuses: {},
    connecting: null,
    error: null,
    connect: vi.fn(async () => true),
    retry: vi.fn(),
    toggle: vi.fn(),
    remove: vi.fn(),
  } as unknown as Connectors;
  render(<ConnectorDetail entry={entry} connectors={connectors} onBack={() => {}} onOpen={() => {}} backLabel="Connectors" />);
  return connectors;
}

describe("a connector's page", () => {
  it("shows the connector as Claude does: its state, address, published tools and sign-in", () => {
    setup();
    expect(screen.getByText(t.notConnected)).toBeTruthy();
    expect(screen.getByText(gmail.url)).toBeTruthy();
    expect(screen.getByText(gmail.tools!.join(", "))).toBeTruthy();
    expect(screen.getByText(t.canSendDataTo.replace("{host}", "gmailmcp.googleapis.com"))).toBeTruthy();
    expect(screen.queryByPlaceholderText("Client ID")).toBeNull();
  });

  it("lists every tool in a dialog with a search", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: t.showAllCount.replace("{count}", String(gmail.tools!.length)) }));
    await act(async () => {});
    const dialog = screen.getByRole("dialog", { name: t.toolsOf.replace("{name}", "Gmail") });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(gmail.tools!.length);
    fireEvent.change(within(dialog).getByPlaceholderText(t.searchTools), { target: { value: "draft" } });
    const drafts = gmail.tools!.filter((t) => t.includes("draft"));
    expect(drafts.length).toBeGreaterThan(0);
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(drafts);
  });

  it("asks for the OAuth client on Connect when the service needs one, then signs in", async () => {
    const connectors = setup(withoutClient);
    fireEvent.click(screen.getAllByRole("button", { name: t.connect })[0]);
    await act(async () => {});
    const dialog = screen.getByRole("dialog", { name: t.oauthCredentials });
    fireEvent.change(within(dialog).getByPlaceholderText("Client ID"), { target: { value: "id.apps.googleusercontent.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t.connect }));
    expect(connectors.connect).toHaveBeenCalledWith(withoutClient, { clientId: "id.apps.googleusercontent.com", clientSecret: "" }, t.missingClientId);
  });

  it("signs in at once with Nyxs's own client, as Claude does", async () => {
    const connectors = setup(withClient);
    fireEvent.click(screen.getAllByRole("button", { name: t.connect })[0]);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(connectors.connect).toHaveBeenCalledWith(withClient, undefined, t.missingClientId);
  });
});
