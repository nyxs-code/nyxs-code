import { invoke } from "@/lib/ipc";

/** The CLIs that keep several accounts Nyxs can switch between (see `cli_accounts.rs`). */
export type MultiAccountCli = "claude-code" | "codex" | "grok";

export interface CliAccount {
  id: string;
  email: string;
  name: string | null;
  plan: string | null;
  /** The account the CLI is signed in with now. */
  active: boolean;
}

export function isMultiAccountCli(cli: string | undefined): cli is MultiAccountCli {
  return cli === "claude-code" || cli === "codex" || cli === "grok";
}

/** Every saved account; the one signed in now is saved too, with its newest tokens. */
export function listCliAccounts(cli: MultiAccountCli): Promise<CliAccount[]> {
  return invoke<CliAccount[]>("cli_accounts_list", { cli });
}

export function activateCliAccount(cli: MultiAccountCli, id: string): Promise<CliAccount[]> {
  return invoke<CliAccount[]>("cli_accounts_activate", { request: { cli, id } });
}

/** Removes a saved account; removing the one in use signs the CLI out. */
export function forgetCliAccount(cli: MultiAccountCli, id: string): Promise<CliAccount[]> {
  return invoke<CliAccount[]>("cli_accounts_forget", { request: { cli, id } });
}

const POLL_MS = 2500;
const POLL_LIMIT_MS = 15 * 60 * 1000;

/** Opens the CLI's own sign-in in a terminal, pointed at a home of its own so the account in
 *  use isn't touched, and waits for it: resolves with the new account, or null when stopped or
 *  after 15 minutes. */
export async function addCliAccount(cli: MultiAccountCli, signal: AbortSignal): Promise<CliAccount | null> {
  const loginId = await invoke<string>("cli_accounts_add_start", { cli });
  const started = Date.now();
  try {
    while (!signal.aborted && Date.now() - started < POLL_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (signal.aborted) break;
      const added = await invoke<CliAccount | null>("cli_accounts_add_poll", { loginId });
      if (added) return added;
    }
    return null;
  } finally {
    // Done or not, the waiting ends: a finished sign-in has already cleaned up after itself.
    void invoke("cli_accounts_add_cancel", { loginId }).catch(() => undefined);
  }
}
