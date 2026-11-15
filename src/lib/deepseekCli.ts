import { startCliProcess, type AgentCliTurn } from "./agentCli";
import { configValues, initializeParams, Rpc, streamAcpAgent, STARTUP_TIMEOUT_MS, type AcpSpec, type Json } from "./acpAgent";
import type { ModelInfo } from "./models";

/**
 * DeepSeek Harness (`dsh`), DeepSeek's own coding agent, over the Agent Client Protocol
 * (`dsh acp`); the protocol itself is in acpAgent.ts. It has no sign-in: it runs on the
 * user's DeepSeek API key, which Nyxs hands it as `DEEPSEEK_API_KEY` for each run. Its model
 * and reasoning level are session config options (`model`, `reasoning_effort`).
 */

export const DEEPSEEK_ACP: AcpSpec = {
  cli: "deepseek",
  label: "DeepSeek Harness",
  args: () => ["acp"],
  authMethods: [],
  loginHint: "Revisa la API key de DeepSeek en Ajustes → Proveedores → DeepSeek Harness.",
};

export function deepseekEnv(apiKey: string | undefined): Record<string, string> | undefined {
  const key = apiKey?.trim();
  return key ? { DEEPSEEK_API_KEY: key } : undefined;
}

export function streamDeepseekCli(t: AgentCliTurn): Promise<string> {
  return streamAcpAgent(DEEPSEEK_ACP, t);
}

/**
 * The models the key gives access to, as DeepSeek Harness offers them in a new session's
 * `model` option ('["deepseek-official","deepseek-v4-pro"]', the route it takes). The session
 * is closed right after. Empty when they can't be read.
 */
export async function fetchDeepseekModels(apiKey?: string): Promise<ModelInfo[]> {
  const rpc = new Rpc("DeepSeek Harness");
  const proc = await startCliProcess("deepseek", ["acp"], null, (line) => rpc.line(line), deepseekEnv(apiKey));
  rpc.proc = proc;
  void proc.exited.then(() => rpc.fail(new Error("DeepSeek Harness terminó")));
  try {
    await rpc.request("initialize", await initializeParams(), STARTUP_TIMEOUT_MS);
    const session = await rpc.request("session/new", { cwd: proc.cwd, mcpServers: [] }, STARTUP_TIMEOUT_MS);
    const options = (Array.isArray(session.configOptions) ? session.configOptions : []) as Json[];
    const model = options.find((o) => o.category === "model" || o.id === "model");
    if (typeof session.sessionId === "string") {
      await rpc.request("session/close", { sessionId: session.sessionId }, STARTUP_TIMEOUT_MS).catch(() => undefined);
    }
    if (!model) return [];
    // Its current choice first: the one it runs when nothing is picked.
    const values = configValues(model).sort((a, b) => Number(b.value === model.currentValue) - Number(a.value === model.currentValue));
    return values.map((v) => ({
      id: `deepseek-cli:${v.value}`,
      apiModel: v.value,
      name: v.name,
      description: v.description ?? "DeepSeek Harness",
      provider: "deepseek-cli" as const,
    }));
  } catch {
    return [];
  } finally {
    proc.closeInput();
    proc.kill();
  }
}
