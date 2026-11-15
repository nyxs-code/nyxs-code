import { truncateNumberedLines } from "@/tools/limits";

export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export interface FileRange {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  encoding?: string | null;
  longLines?: number;
}

export function formatReadRange(range: FileRange, max: number): string {
  const { text, lastLine } = truncateNumberedLines(range.text, max);
  const endLine = lastLine ?? range.endLine;
  if (range.endLine === 0) {
    return range.totalLines > 0 ? `${text.trimEnd()} The file has ${range.totalLines} lines.` : text;
  }
  const partial = range.startLine > 1 || endLine < range.totalLines;
  if (!partial) return text;
  const more =
    endLine < range.totalLines
      ? ` Use offset=${endLine + 1} to continue.`
      : " This is the end of the file.";
  const cut = lastLine !== null ? " (output size limit reached)" : "";
  return `${text}\n[Showing lines ${range.startLine}-${endLine} of ${range.totalLines}${cut}.${more}]`;
}

export interface ReadImageOutput {
  __readImage: true;
  base64: string;
  mediaType: string;
  size: number;
  filePath: string;
}

export function readImageModelOutput(o: ReadImageOutput, nativeToolImages: boolean) {
  const name = o.filePath.split(/[\\/]/).filter(Boolean).pop() ?? "image";
  const sizeKb = Math.round(o.size / 1024);
  const image = nativeToolImages
    ? { type: "image-data" as const, data: o.base64, mediaType: o.mediaType }
    : { type: "file-data" as const, data: o.base64, mediaType: o.mediaType, filename: name };
  return {
    type: "content" as const,
    value: [{ type: "text" as const, text: `Read image ${o.filePath} (${sizeKb} KB). The image is attached below.` }, image],
  };
}
