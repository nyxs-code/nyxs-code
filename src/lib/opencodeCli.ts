import type { AgentCliTurn } from "./agentCli";
import { streamAcpAgent, type AcpSpec } from "./acpAgent";

/**
 * OpenCode over the Agent Client Protocol (`opencode acp`); the protocol itself is in
 * acpAgent.ts. Its models are "provider/model" ids from the providers it was signed in to
 * (`opencode auth login`), picked with `session/set_model`. Each turn is its own process, so
 * an idle signal from another turn can't end this one early.
 */

export const OPENCODE_ACP: AcpSpec = {
  cli: "opencode",
  label: "OpenCode",
  args: () => ["acp"],
  authMethods: [],
  // It runs on the providers `opencode auth login` saved (or keys in the environment).
  authenticate: false,
  loginHint: "Inicia sesión en un proveedor con «opencode auth login».",
};

export function streamOpenCodeCli(t: AgentCliTurn): Promise<string> {
  return streamAcpAgent(OPENCODE_ACP, t);
}
