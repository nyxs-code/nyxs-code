import { z, type ZodType } from "zod";
import { structuredInstruction, retryInstruction, parseStructured } from "./structuredOutput";
import type { ActivityEvent } from "./agentActivity";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentRunner = (
  prompt: string,
  opts: {
    subagentType?: string;
    model?: string;
    signal?: AbortSignal;
    onUsage?: (usage: AgentUsage) => void;
    onActivity?: (activity: ActivityEvent) => void;
    schema?: ZodType;
  },
) => Promise<string>;

/** What a stopped agent hands back in place of its report. */
export const STOPPED_NOTE = "[Stopped by the user before it finished.]";

/** A stopped agent's partial report, marked as such once. */
export function withStoppedNote(text: string): string {
  const partial = text.trim();
  if (!partial) return STOPPED_NOTE;
  return partial.endsWith(STOPPED_NOTE) ? partial : `${partial}\n\n${STOPPED_NOTE}`;
}

export type OrchestratorEvent =
  | { kind: "agent:start"; id: number; label: string; phase?: string; stop?: () => void }
  | { kind: "agent:end"; id: number; label: string; phase?: string; ok: boolean; ms: number; usage?: AgentUsage; stopped?: boolean }
  | { kind: "agent:retry"; id: number; label: string; attempt: number; reason: string }
  | { kind: "agent:activity"; id: number; activity: ActivityEvent }
  | { kind: "phase"; title: string }
  | { kind: "log"; message: string };

export interface OrchestratorOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (e: OrchestratorEvent) => void;
}

export interface AgentCallOptions<T = string> {
  label?: string;
  phase?: string;
  schema?: ZodType<T>;
  subagentType?: string;
  model?: string;
  maxRetries?: number;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

class AbortError extends Error {
  constructor() {
    super("Orchestration aborted");
    this.name = "AbortError";
  }
}

function defaultConcurrency(): number {
  const cores =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(8, cores - 2));
}

export { extractJson } from "./structuredOutput";

export interface Orchestrator {
  agent<T = string>(prompt: string, opts?: AgentCallOptions<T>): Promise<T>;
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline<I, O>(items: I[], ...stages: PipelineStage[]): Promise<Array<O | null>>;
  phase(title: string): void;
  log(message: string): void;
  reviewAndVerify<F>(cfg: ReviewConfig<F>): Promise<F[]>;
  migrate<I, R>(cfg: MigrateConfig<I, R>): Promise<Array<MigrateResult<R>>>;
}

export type PipelineStage = (prev: unknown, item: unknown, index: number) => Promise<unknown>;

let agentSeq = 0;

/** An id no other agent shown in a Workflow view has had: workflows and sub-agents of the same
 *  chat share its view, so ids counted per run would collide there. */
export function newAgentId(): number {
  return ++agentSeq;
}

export function createOrchestrator(runAgent: AgentRunner, options: OrchestratorOptions = {}): Orchestrator {
  const limit = options.concurrency ?? defaultConcurrency();
  const sem = new Semaphore(limit);
  const signal = options.signal;
  const emit = (e: OrchestratorEvent) => options.onEvent?.(e);
  let currentPhase: string | undefined;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new AbortError();
  };

  async function agent<T = string>(prompt: string, opts: AgentCallOptions<T> = {}): Promise<T> {
    const id = newAgentId();
    const label = opts.label ?? truncate(prompt);
    const phase = opts.phase ?? currentPhase;
    const maxRetries = opts.maxRetries ?? 2;

    return sem.run(async () => {
      throwIfAborted();
      const startedAt = now();
      // Its own signal, so one agent can be stopped without stopping the others.
      const own = new AbortController();
      const relay = () => own.abort();
      signal?.addEventListener("abort", relay, { once: true });
      const stoppedByUser = () => own.signal.aborted && !signal?.aborted;
      emit({ kind: "agent:start", id, label, phase, stop: relay });
      let ok = false;
      const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
      const onUsage = (u: AgentUsage) => {
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
      };
      const onActivity = (activity: ActivityEvent) => emit({ kind: "agent:activity", id, activity });
      try {
        let prompt2 = opts.schema ? prompt + structuredInstruction(opts.schema) : prompt;
        for (let attempt = 0; ; attempt++) {
          throwIfAborted();
          const text = await runAgent(prompt2, {
            subagentType: opts.subagentType,
            model: opts.model,
            signal: own.signal,
            onUsage,
            onActivity,
            schema: opts.schema,
          }).catch((e) => {
            if (stoppedByUser()) return "";
            throw e;
          });
          if (stoppedByUser()) {
            if (opts.schema) throw new Error("stopped by the user");
            return withStoppedNote(text) as unknown as T;
          }
          if (!opts.schema) {
            ok = true;
            return text as unknown as T;
          }
          const parsed = parseStructured(text, opts.schema);
          if (parsed.ok) {
            ok = true;
            return parsed.value;
          }
          if (attempt >= maxRetries) {
            throw new Error(`schema validation failed after ${attempt + 1} attempts: ${parsed.error}`);
          }
          emit({ kind: "agent:retry", id, label, attempt: attempt + 1, reason: parsed.error });
          prompt2 = retryInstruction(prompt, parsed.error);
        }
      } finally {
        signal?.removeEventListener("abort", relay);
        emit({ kind: "agent:end", id, label, phase, ok, ms: now() - startedAt, usage, stopped: stoppedByUser() });
      }
    });
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    const local = new Semaphore(limit);
    return Promise.all(
      thunks.map((t) =>
        local.run(async () => {
          throwIfAborted();
          return t();
        }).catch((e) => {
          if (e instanceof AbortError) throw e;
          return null;
        }),
      ),
    );
  }

  function pipeline<I, O>(items: I[], ...stages: PipelineStage[]): Promise<Array<O | null>> {
    const DROP = Symbol("drop");
    const local = new Semaphore(limit);
    const runs = items.map((item, i) => {
      let chain: Promise<unknown> = Promise.resolve(item);
      for (const stage of stages) {
        chain = chain.then((prev) => {
          if (prev === DROP) return DROP;
          return local
            .run(async () => {
              throwIfAborted();
              return stage(prev, item, i);
            })
            .catch((e) => {
              if (e instanceof AbortError) throw e;
              return DROP;
            });
        });
      }
      return chain;
    });
    return Promise.all(runs).then((settled) =>
      settled.map((r) => (r === DROP ? null : (r as O))),
    );
  }

  function phase(title: string): void {
    currentPhase = title;
    emit({ kind: "phase", title });
  }

  function log(message: string): void {
    emit({ kind: "log", message });
  }

  const self: Orchestrator = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    reviewAndVerify: (cfg) => reviewAndVerify(self, cfg),
    migrate: (cfg) => migrate(self, cfg),
  };
  return self;
}

function truncate(s: string, n = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function now(): number {
  return Date.now();
}

export interface ReviewConfig<F> {
  dimensions: Array<{ key: string; prompt: string }>;
  findingsSchema: ZodType<{ findings: F[] }>;
  verifyPrompt: (finding: F) => string;
  verdictSchema: ZodType<{ confirmed: boolean }>;
  verifiers?: number;
  minConfirmations?: number;
  dedupeKey?: (finding: F) => string;
  maxRetries?: number;
}

export async function reviewAndVerify<F>(o: Orchestrator, cfg: ReviewConfig<F>): Promise<F[]> {
  const verifiers = cfg.verifiers ?? 3;
  const need = cfg.minConfirmations ?? Math.floor(verifiers / 2) + 1;
  const maxRetries = cfg.maxRetries ?? 1;
  const seen = new Set<string>();

  const perDimension = await o.pipeline<{ key: string; prompt: string }, F[]>(
    cfg.dimensions,
    (_prev, item) => {
      const dim = item as { key: string; prompt: string };
      return o.agent(dim.prompt, {
        label: `review:${dim.key}`,
        phase: "Review",
        schema: cfg.findingsSchema,
        maxRetries,
      }).then((r) => r.findings);
    },
    (prev) => {
      const findings = prev as F[];
      const fresh = findings.filter((f) => {
        const key = cfg.dedupeKey?.(f) ?? JSON.stringify(f);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return o.parallel(
        fresh.map((f) => async () => {
          const verdicts = await o.parallel(
            Array.from({ length: verifiers }, (_unused, i) => () =>
              o.agent(cfg.verifyPrompt(f), {
                label: `verify#${i + 1}`,
                phase: "Verify",
                schema: cfg.verdictSchema,
                maxRetries,
              }),
            ),
          );
          const confirms = verdicts.filter((v) => v?.confirmed).length;
          return confirms >= need ? f : null;
        }),
      ).then((kept) => kept.filter((f): f is F => f != null));
    },
  );

  return perDimension.filter((x): x is F[] => x != null).flat();
}

export interface MigrateConfig<I, R> {
  items: I[];
  transform: (item: I, index: number) => Promise<R>;
  verify?: (result: R, item: I, index: number) => Promise<boolean>;
}

export interface MigrateResult<R> {
  ok: boolean;
  result: R | null;
}

export async function migrate<I, R>(o: Orchestrator, cfg: MigrateConfig<I, R>): Promise<Array<MigrateResult<R>>> {
  const out = await o.pipeline<I, MigrateResult<R>>(
    cfg.items,
    (_prev, item, i) => cfg.transform(item as I, i).then((result) => ({ result })),
    async (prev, item, i) => {
      const { result } = prev as { result: R };
      if (!cfg.verify) return { ok: true, result };
      const ok = await cfg.verify(result, item as I, i);
      return { ok, result };
    },
  );
  return out.map((r) => r ?? { ok: false, result: null });
}

export { z };
