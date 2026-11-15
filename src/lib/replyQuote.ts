export function quoteForReply(quote: string, text: string): string {
  const quoted = quote
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n${text.trim()}`;
}
