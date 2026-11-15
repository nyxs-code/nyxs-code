---
name: model-reasoning-handling
description: How Nyxs separates a model's chain-of-thought (<think>…</think>) from its final answer across MANY different model families, using a defensive stream parser plus model-agnostic system-prompt reinforcement. Covers why both layers are needed and how to tune them.
when_to_use: Use when changing how Nyxs streams responses or separates reasoning/thinking from the answer, when handling <think> / </think> tags, when reasoning leaks into the visible chat, or when adding/debugging support for a new model family's reasoning behavior.
---

# Model reasoning handling (cross-model)

Nyxs serves **thousands of models** with different reasoning behaviors. NEVER over-fit the logic to one model — what works for kimi/DeepSeek-R1/QwQ must not break Anthropic, OpenAI, or non-reasoning models. Reasoning handling has **two layers, both required**.

## Layer 1 — Defensive stream parser
Location: `src/lib/ai.ts`, inside `processStream` → `routeText` / `flushPending`.

It splits inline `<think>…</think>` out of the text stream and routes that content to `onReasoning` (the collapsible reasoning block); only the real answer reaches `emit`. It MUST tolerate the dirty output weak/open models actually produce:

- **Orphan `</think>`** (a close with no matching open) → text before it is reclassified as reasoning.
- **Reasoning interleaved between tool calls**, in any language.
- **Tags split across stream deltas** (`<thi` + `nk>`).
- **Tags are never shown** to the user.
- `ANSWER_HOLD_CAP` (default 1200 chars) is the tuning dial: in "answer" mode the text is held so it can be reclassified to reasoning if a `</think>` arrives later. A reasoning block longer than the cap before its close will leak partially — an honest streaming limit (you cannot un-emit painted text). Reasoning streams live; only answer text is held. Raise the cap if long reasoning leaks; lower it if long answers feel laggy.

## Layer 2 — System-prompt reinforcement
Location: `src/lib/systemPrompt.ts`, `COMMUNICATING` section.

A model-agnostic instruction telling models: always close every `<think>`, never emit a bare `</think>`, and — crucially — if the model already streams reasoning through a native channel, do NOT also wrap text in these tags. This fixes the *cause* (inconsistent tagging) without harming native-reasoning models or non-reasoning ones.

## Why both
The prompt nudges well-behaved models to tag consistently; the parser is the safety net for the ones that ignore the prompt. Either layer alone is insufficient.

## When adding a new model family
1. Check whether it emits reasoning inline (in text) or via a separate reasoning channel (`reasoning-delta`).
2. If inline with non-standard delimiters (not `<think>`/`</think>`), extend the parser's tag set rather than hard-coding model names.
3. Verify the parser with: orphan close, interleaved reasoning, split tags, and a long untagged answer (must still stream).
4. Keep everything model-agnostic — no `if (model === "x")` branches in the reasoning path.
