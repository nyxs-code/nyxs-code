/** What answers on the dev port: nothing, this project's Vite, or something else. */
export function probe(port?: number, root?: string): Promise<"free" | "ours" | "other">;
