import { invoke } from "@/lib/ipc";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AUTH_BASE, getToken } from "./auth";
import { getMergedSnapshot } from "./settingsRuntime";
import { DEFAULT_SETTINGS } from "./configSchema";
import { getRagConsent } from "./globalConfig";
import { privacySettings } from "./privacySettings";

const http = tauriFetch as unknown as typeof fetch;

/** Where a chunk of the project is now (rag_store follows moved files and repeated text). */
interface ChunkRef {
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
}

interface Chunk extends ChunkRef {
  /** Empty for a `known` chunk: its vector is already in the index. */
  text: string;
  known: boolean;
}

interface StoredInput {
  hash: string;
  vector: number[];
}

export interface RagHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface RagStats {
  chunks: number;
  files: number;
  model: string;
  dim: number;
  exists: boolean;
}

export interface RagConfig {
  enabled: boolean;
  embeddingModel: string;
  topK: number;
  maxFileSize: number;
  autoIndex: boolean;
  provider: "backend" | "mock";
}

export function ragConfig(): RagConfig {
  const snap = (getMergedSnapshot() as { rag?: Partial<RagConfig> }).rag ?? {};
  return { ...DEFAULT_SETTINGS.rag, ...snap } as RagConfig;
}

/**
 * Whether this project's text may go to the Nyxs service for semantic search: the user turned
 * it on in Settings › Privacy and answered "Index" for this project (RagConsentDialog). The
 * local mock provider sends nothing, so it always may.
 */
export async function ragServiceAllowed(workspace: string): Promise<boolean> {
  if (ragConfig().provider === "mock") return true;
  if (!(await privacySettings()).semanticSearch) return false;
  return (await getRagConsent(workspace)) === "granted";
}

async function assertServiceAllowed(workspace: string): Promise<void> {
  if (!(await ragServiceAllowed(workspace))) {
    throw new Error(
      "Semantic search on the Nyxs service is off for this project (Settings › Privacy), so nothing was sent.",
    );
  }
}

const MOCK_DIM = 256;

function mockEmbed(text: string): number[] {
  const v = new Array(MOCK_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % MOCK_DIM] += 1;
  }
  return v;
}

async function embedTexts(
  texts: string[],
  cfg: RagConfig,
  inputType: "passage" | "query" = "passage",
): Promise<number[][]> {
  if (cfg.provider === "mock") {
    return texts.map(mockEmbed);
  }
  const token = await getToken();
  if (!token) {
    throw new Error("No hay sesión iniciada: el indexado RAG necesita autenticación.");
  }
  const res = await http(`${AUTH_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: texts, model: cfg.embeddingModel, inputType }),
  });
  if (!res.ok) {
    throw new Error(
      `El backend de embeddings respondió ${res.status}. ` +
        `Verifica que /api/embeddings esté disponible o usa el proveedor "mock".`,
    );
  }
  const data = (await res.json()) as
    | { embeddings?: number[][] }
    | { data?: { embedding: number[] }[] };
  if ("embeddings" in data && Array.isArray(data.embeddings)) return data.embeddings;
  if ("data" in data && Array.isArray(data.data)) return data.data.map((d) => d.embedding);
  throw new Error("Respuesta de embeddings con formato inesperado.");
}

const EMBED_BATCH = 64;
/** How many new vectors are saved at a time: a batch that fails later loses only what came after
 *  the last save, not the whole pass. */
const STORE_EVERY = 512;

export interface IndexProgress {
  phase: "collecting" | "embedding" | "storing" | "done";
  embedded: number;
  total: number;
}

export async function ragIndex(
  workspace: string,
  onProgress?: (p: IndexProgress) => void,
): Promise<RagStats> {
  await assertServiceAllowed(workspace);
  const cfg = ragConfig();
  onProgress?.({ phase: "collecting", embedded: 0, total: 0 });

  const model = `${cfg.provider}:${cfg.embeddingModel}`;
  // The chunks already indexed for this model come without their text.
  const chunks: Chunk[] = await invoke("rag_collect_chunks", {
    workspace,
    maxFileBytes: cfg.maxFileSize,
    model,
  });
  const current: ChunkRef[] = chunks.map(({ path, startLine, endLine, hash }) => ({ path, startLine, endLine, hash }));

  const seen = new Set<string>();
  const todo = chunks.filter((c) => !c.known && !seen.has(c.hash) && seen.add(c.hash));

  const store = (newEntries: StoredInput[]) => invoke<RagStats>("rag_store", { workspace, model, newEntries, current });
  let pending: StoredInput[] = [];
  let stats: RagStats | null = null;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((c) => c.text), cfg);
    batch.forEach((c, j) => pending.push({ hash: c.hash, vector: vectors[j] }));
    onProgress?.({ phase: "embedding", embedded: Math.min(i + batch.length, todo.length), total: todo.length });
    if (pending.length >= STORE_EVERY) {
      stats = await store(pending);
      pending = [];
    }
  }

  onProgress?.({ phase: "storing", embedded: todo.length, total: todo.length });
  // Also with nothing new: the index follows files that moved or were deleted.
  if (pending.length || !stats) stats = await store(pending);
  onProgress?.({ phase: "done", embedded: todo.length, total: todo.length });
  return stats;
}

export async function ragQuery(workspace: string, query: string, topK?: number): Promise<RagHit[]> {
  await assertServiceAllowed(workspace);
  const cfg = ragConfig();
  const [vector] = await embedTexts([query], cfg, "query");
  return invoke<RagHit[]>("rag_search", { workspace, vector, topK: topK ?? cfg.topK });
}

export function ragStats(workspace: string): Promise<RagStats> {
  return invoke<RagStats>("rag_stats", { workspace });
}
