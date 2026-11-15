/**
 * Codex's patch format, the one GPT models are trained to write:
 *
 *   *** Begin Patch
 *   *** Add File: path        then the file's lines, each starting with "+"
 *   *** Delete File: path
 *   *** Update File: path     optionally "*** Move to: new/path", then hunks:
 *   @@ optional line to find   lines starting with " " (context), "-" (removed), "+" (added)
 *   *** End of File            optional, after a hunk that ends at the end of the file
 *   *** End Patch
 */

export interface PatchHunk {
  /** The text after "@@": a line the change comes after when it has no context of its own. */
  header: string;
  /** Context and removed lines, in order: the text that must be in the file. */
  oldLines: string[];
  /** Context and added lines, in order: what it becomes. */
  newLines: string[];
  /** Marked with "*** End of File". */
  endOfFile: boolean;
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

export class PatchError extends Error {}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARK = "*** End of File";

/** The patch as a heredoc (`cat <<'EOF' … EOF`), as models trained on a shell tool send it. */
function unwrapHeredoc(text: string): string {
  return /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/.exec(text)?.[2] ?? text;
}

/** The operations of a patch, in order. Throws a PatchError saying what's wrong and where. */
export function parsePatch(text: string): PatchOp[] {
  const lines = unwrapHeredoc(text.replace(/\r\n/g, "\n").trim()).split("\n");
  if (lines[0]?.trim() !== BEGIN) throw new PatchError(`The patch must start with "${BEGIN}".`);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === END);
  if (end < 0) throw new PatchError(`The patch must end with "${END}" (it may have been cut off).`);
  const ops: PatchOp[] = [];
  let i = 1;
  const at = (n: number) => `line ${n + 1} of the patch`;
  while (i < end) {
    const line = lines[i];
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      if (!path) throw new PatchError(`No path after "${ADD.trim()}" (${at(i)}).`);
      const body: string[] = [];
      // Bare empty lines at the end separate this file from the next operation.
      let bareTail = 0;
      for (i++; i < end && !lines[i].startsWith("*** "); i++) {
        // An empty line inside is a blank line whose "+" got lost.
        if (lines[i] === "") {
          body.push("");
          bareTail++;
        } else if (!lines[i].startsWith("+")) throw new PatchError(`Every line of an added file starts with "+" (${at(i)}, in ${path}).`);
        else {
          body.push(lines[i].slice(1));
          bareTail = 0;
        }
      }
      body.length -= bareTail;
      ops.push({ type: "add", path, content: body.length ? `${body.join("\n")}\n` : "" });
    } else if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim();
      if (!path) throw new PatchError(`No path after "${DELETE.trim()}" (${at(i)}).`);
      ops.push({ type: "delete", path });
      i++;
    } else if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      if (!path) throw new PatchError(`No path after "${UPDATE.trim()}" (${at(i)}).`);
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith(MOVE)) {
        moveTo = lines[i].slice(MOVE.length).trim() || undefined;
        i++;
      }
      const hunks: PatchHunk[] = [];
      let hunk: PatchHunk | null = null;
      // Bare empty lines at a hunk's end separate it from what follows, rather than being context.
      let bareTail = 0;
      const closeHunk = () => {
        if (hunk && bareTail) {
          hunk.oldLines.length -= bareTail;
          hunk.newLines.length -= bareTail;
        }
        bareTail = 0;
      };
      for (; i < end && !(lines[i].startsWith("*** ") && lines[i].trim() !== EOF_MARK); i++) {
        const l = lines[i];
        if (l.startsWith("@@")) {
          closeHunk();
          hunk = { header: l.slice(2).trim(), oldLines: [], newLines: [], endOfFile: false };
          hunks.push(hunk);
          continue;
        }
        if (l.trim() === EOF_MARK) {
          if (hunk) hunk.endOfFile = true;
          continue;
        }
        // The first hunk may leave out its "@@".
        if (!hunk) {
          hunk = { header: "", oldLines: [], newLines: [], endOfFile: false };
          hunks.push(hunk);
        }
        const marker = l[0];
        const body = l.slice(1);
        bareTail = l === "" ? bareTail + 1 : 0;
        if (marker === "+") hunk.newLines.push(body);
        else if (marker === "-") hunk.oldLines.push(body);
        // An empty line inside is a blank context line whose leading space got lost.
        else if (marker === " " || l === "") {
          hunk.oldLines.push(body);
          hunk.newLines.push(body);
        } else throw new PatchError(`A hunk line must start with " ", "-" or "+" (${at(i)}, in ${path}): ${JSON.stringify(l.slice(0, 80))}`);
      }
      closeHunk();
      const changes = hunks.filter((h) => h.oldLines.join("\n") !== h.newLines.join("\n"));
      if (!changes.length && !moveTo) throw new PatchError(`"${UPDATE.trim()} ${path}" has no changes.`);
      ops.push({ type: "update", path, moveTo, hunks: changes });
    } else if (line.trim() === "") {
      i++;
    } else {
      throw new PatchError(`Expected "${ADD.trim()}", "${DELETE.trim()}" or "${UPDATE.trim()}" (${at(i)}): ${JSON.stringify(line.slice(0, 80))}`);
    }
  }
  if (!ops.length) throw new PatchError("The patch has no file operations.");
  return ops;
}

/** The files a patch touches, for its card and permission prompts (before it is applied). */
export function patchPaths(text: string): string[] {
  try {
    return parsePatch(text).flatMap((op) => (op.type === "update" && op.moveTo ? [op.path, op.moveTo] : [op.path]));
  } catch {
    return [];
  }
}
