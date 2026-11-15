const DEV =
  typeof import.meta !== "undefined" && Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

interface ToolLike {
  description?: string;
}

export interface PromptStateSnapshot {
  source: string;
  systemBlocks: string[];
  cacheIndex: number;
  tools?: Record<string, ToolLike> | undefined;
  model: string;
  effort?: string;
}

interface PreviousState {
  prefixHash: number;
  prefixChars: number;
  toolsHash: number;
  toolNames: string[];
  perToolHash: Record<string, number>;
  model: string;
  effort: string;
  callCount: number;
}

const MAX_TRACKED_SOURCES = 16;

const previousBySource = new Map<string, PreviousState>();

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function toolEntries(tools: PromptStateSnapshot["tools"]): [string, string][] {
  if (!tools) return [];
  return Object.keys(tools)
    .sort()
    .map((name) => [name, tools[name]?.description ?? ""] as [string, string]);
}

export function recordPromptState(snapshot: PromptStateSnapshot): void {
  if (!DEV) return;
  try {
    const { source, systemBlocks, cacheIndex, tools, model } = snapshot;
    const effort = snapshot.effort ?? "";

    const prefixBlocks = systemBlocks.slice(0, Math.max(0, cacheIndex + 1));
    const prefixText = prefixBlocks.join("\n\n");
    const prefixHash = djb2(prefixText);
    const prefixChars = prefixText.length;

    const entries = toolEntries(tools);
    const toolNames = entries.map(([name]) => name);
    const perToolHash: Record<string, number> = {};
    for (const [name, desc] of entries) perToolHash[name] = djb2(desc);
    const toolsHash = djb2(entries.map(([n, d]) => `${n}\n${d}`).join("\n\n"));

    const prev = previousBySource.get(source);
    const next: PreviousState = {
      prefixHash,
      prefixChars,
      toolsHash,
      toolNames,
      perToolHash,
      model,
      effort,
      callCount: (prev?.callCount ?? 0) + 1,
    };

    if (!prev) {
      while (previousBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousBySource.keys().next().value;
        if (oldest === undefined) break;
        previousBySource.delete(oldest);
      }
      previousBySource.set(source, next);
      return;
    }

    previousBySource.set(source, next);

    const parts: string[] = [];

    if (model !== prev.model) parts.push(`model (${prev.model} → ${model})`);

    if (prefixHash !== prev.prefixHash) {
      const delta = prefixChars - prev.prefixChars;
      const deltaStr = delta === 0 ? "same length" : delta > 0 ? `+${delta} chars` : `${delta} chars`;
      parts.push(`system prefix (${deltaStr})`);
    }

    if (toolsHash !== prev.toolsHash) {
      const prevSet = new Set(prev.toolNames);
      const nextSet = new Set(toolNames);
      const added = toolNames.filter((n) => !prevSet.has(n));
      const removed = prev.toolNames.filter((n) => !nextSet.has(n));
      if (added.length || removed.length) {
        parts.push(`tools (+${added.length}/-${removed.length}${added.length ? ` added: ${added.join(",")}` : ""}${removed.length ? ` removed: ${removed.join(",")}` : ""})`);
      } else {
        const changed = toolNames.filter((n) => prevSet.has(n) && perToolHash[n] !== prev.perToolHash[n]);
        parts.push(`tool descriptions changed: ${changed.join(",") || "(unknown)"}`);
      }
    }

    if (effort !== prev.effort) parts.push(`effort (${prev.effort || "default"} → ${effort || "default"})`);

    if (parts.length > 0) {
      console.warn(
        `[prompt-cache] cacheable prefix changed for "${source}" (call #${next.callCount}) — this request likely misses the prompt cache. Cause(s): ${parts.join("; ")}`,
      );
    }
  } catch {
    // Diagnostic only — never let it disturb the request path.
  }
}
