import { readFileSync } from "node:fs";

// Fails (exit 1) rather than printing a stand-in: the release job publishes whatever this
// prints as the notes users read in the update alert and on the releases page.
function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) fail("usage: node scripts/release-notes.mjs <version>");

// NYXS_CHANGELOG points the tests at a changelog of their own.
const url = process.env.NYXS_CHANGELOG ?? new URL("../src/lib/changelog.ts", import.meta.url);
const src = readFileSync(url, "utf8");

const m = src.match(/CHANGELOG[^=]*=\s*(\[[\s\S]*?\n\]);/);
if (!m) fail("could not find the CHANGELOG array in src/lib/changelog.ts.");

let entries;
try {
  entries = new Function("return (" + m[1] + ")")();
} catch (e) {
  fail(`could not parse the CHANGELOG in src/lib/changelog.ts: ${e.message}`);
}
if (!Array.isArray(entries)) fail("CHANGELOG in src/lib/changelog.ts is not an array.");

const entry = entries.find((e) => e.version === version);
if (!entry) fail(`src/lib/changelog.ts has no entry for ${version}. Add one before tagging the release.`);

const lines = [];
const news = [...(entry.added ?? []), ...(entry.improved ?? [])];
if (news.length) {
  lines.push("## What's New");
  for (const x of news) lines.push(`- ${x}`);
}
if (entry.fixed?.length) {
  if (lines.length) lines.push("");
  lines.push("## Fixes");
  for (const x of entry.fixed) lines.push(`- ${x}`);
}
if (!lines.length) fail(`the ${version} entry in src/lib/changelog.ts has no added, improved or fixed items.`);

// The update card's slides, hidden from the release page in an HTML comment. Same format as
// cardComment() in src/lib/updateCard.ts: `--` can't appear inside a comment.
if (entry.card) {
  lines.push("", `<!-- nyxs-card ${JSON.stringify(entry.card).replace(/--/g, "-\\u002d")} -->`);
}

process.stdout.write(lines.join("\n"));
