export const truncatedToolCalls = new Set<string>();

export const CONTENT_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch"]);

export function truncatedWriteMessage(filePath: string): string {
  return (
    `ERROR: the output was cut off by the provider's token limit, so the content for ${filePath} ` +
    `is incomplete. The file was NOT written, to avoid corrupting it with a truncated tail. ` +
    `Recover by making a smaller change: use Edit/MultiEdit to modify only the part that needs to ` +
    `change, or split a large file into several smaller Write calls. Do NOT retry the same full Write.`
  );
}
