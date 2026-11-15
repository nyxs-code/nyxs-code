/** An answer from Nyxs' question prompt as the CLI needs it: the question prompt joins the options
 *  picked and the text typed with ", " (typed text last), so splitting on commas cut an option like
 *  "Yes, continue" in two. Labels are matched whole, the longest first; what's left is the text. */
export function splitAnswer(answer: string, labels: string[]): { picked: string[]; text: string } {
  const sorted = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  let at = 0;
  for (;;) {
    const label = sorted.find((l) => answer.startsWith(l, at) && (at + l.length === answer.length || answer.startsWith(", ", at + l.length)));
    if (!label) break;
    picked.push(label);
    at += label.length;
    if (at === answer.length) return { picked, text: "" };
    at += 2;
  }
  return { picked, text: answer.slice(at).trim() };
}
