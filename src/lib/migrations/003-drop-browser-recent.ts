import type { Migration } from "./types";

const KEY = "nyxs.browserRecent.v1";

/** Deletes the built-in browser's recent addresses, of every account (`<key>::<uid>`). Nothing
 *  reads them since the address bar suggests from the search engine instead (2026-10-31). */
async function up(): Promise<void> {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
  for (const key of keys) {
    if (key === KEY || key.startsWith(`${KEY}::`)) localStorage.removeItem(key);
  }
}

export const migration003: Migration = {
  id: 3,
  name: "drop the built-in browser's recent addresses",
  up,
};
