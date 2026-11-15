import { LIST_DIR_TOOL_NAME, READ_PDF_TOOL_NAME, WATCH_VIDEO_TOOL_NAME } from "../toolNames";

export const MAX_LINES_TO_READ = 2000;

export function getReadDescription(): string {
  return `Reads a file from the local filesystem. You can read any text file on the machine.

Usage:
- The file_path parameter can be absolute or relative to the working folder. If the user gives a path, assume it is valid; reading a file that does not exist returns an error.
- By default it reads up to ${MAX_LINES_TO_READ} lines from the start of the file. When you already know which part of a long file you need, pass offset and limit to read only that range.
- Results are returned in cat -n format, with line numbers starting at 1. offset uses those same numbers: offset=120 starts at the line shown as 120.
- When only part of the file was returned, the result ends with "[Showing lines A-B of N ...]" and tells you which offset to use to continue. If that note is absent, you saw the whole file.
- This tool only reads files, not directories. To list a directory use ${LIST_DIR_TOOL_NAME} (or Glob).
- Images (.png, .jpg, .webp, .gif, .bmp) are supported: on a vision-capable model the image is attached so you can see it directly; on a text-only model you get a short note instead. Just call Read on the image path.
- To read a PDF, use ${READ_PDF_TOOL_NAME}. To watch a video, use ${WATCH_VIDEO_TOOL_NAME}.
- If you read a file that exists but is empty, you'll get a notice instead of content.
- Do NOT re-read a file you already read earlier in this conversation unless you edited it or the user changed it — its contents are still in your context, and the Read result tells you when a file is unchanged.`;
}
