import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import type { Translations } from "../locales/types";

/** What a Rust command sends when it fails with a `CmdError` (src-tauri/src/error.rs). */
interface CmdErrorPayload {
  code: string;
  message: string;
  params?: Record<string, string>;
}

function isCmdErrorPayload(e: unknown): e is CmdErrorPayload {
  return (
    typeof e === "object" && e !== null &&
    typeof (e as CmdErrorPayload).code === "string" && typeof (e as CmdErrorPayload).message === "string"
  );
}

/** A backend failure with a code the UI can translate. `message` is the English text, which is
 *  what the agent, the logs and every `String(e)` / `${e}` get. */
export class BackendError extends Error {
  readonly code: string;
  readonly params: Record<string, string>;

  constructor(payload: CmdErrorPayload) {
    super(payload.message);
    this.name = "BackendError";
    this.code = payload.code;
    this.params = payload.params ?? {};
  }

  override toString(): string {
    return this.message;
  }
}

/** `invoke` from Tauri, but a coded backend error rejects as a `BackendError` instead of a
 *  plain object, so code that turns errors into text keeps working. Import `invoke` from here,
 *  never from "@tauri-apps/api/core" (eslint enforces it). */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    throw isCmdErrorPayload(e) ? new BackendError(e) : e;
  }
}

/** The text to show the user for any error, in their language when the backend sent a code the
 *  locales know; otherwise the error's own message. */
export function describeError(e: unknown, t: Pick<Translations, "errors">): string {
  if (e instanceof BackendError) {
    const template = (t.errors as Record<string, string | undefined>)[e.code];
    if (template) return template.replace(/\{(\w+)\}/g, (whole, key: string) => e.params[key] ?? whole);
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
