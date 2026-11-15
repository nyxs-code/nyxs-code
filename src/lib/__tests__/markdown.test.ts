import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "@/components/message/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(MarkdownText, { text }));

describe("MarkdownText", () => {
  it("does not italicize underscores inside identifiers", () => {
    expect(html("rename file_name_here and my_var")).not.toContain("<em>");
    expect(html("this is _really_ important")).toContain("<em>really</em>");
  });

  it("renders headings as heading elements", () => {
    expect(html("## Plan")).toMatch(/<h2[^>]*>Plan<\/h2>/);
    expect(html("### Steps")).toMatch(/<h3[^>]*>Steps<\/h3>/);
  });

  it("renders blockquotes and nested list indentation", () => {
    expect(html("> quoted **text**")).toMatch(/<blockquote[^>]*><p[^>]*>quoted <strong[^>]*>text<\/strong><\/p><\/blockquote>/);
    expect(html("- a\n  - b")).toContain("margin-left:18px");
  });
  it("keeps a numbered list's numbers after a blank line, a code block or a continuation", () => {
    // After a code block the list goes on in another text segment: it starts at its own number.
    expect(html("3. third\n4. fourth")).toContain('<ol start="3"');
    const split = html("1. one\n2. two\n\n3. three");
    expect(split).toContain('<ol start="3"');
    const continued = html("1. one\n   still one\n2. two");
    expect(continued.match(/<ol/g)).toHaveLength(1);
    expect(continued).toMatch(/<li[^>]*>one\nstill one<\/li>/);
  });

  it("renders the content of bold and italic text", () => {
    expect(html("**run `npm i` first**")).toMatch(/<strong[^>]*>run <code[^>]*>npm i<\/code> first<\/strong>/);
    expect(html("_see **this**_")).toMatch(/<em><strong[^>]*>this<\/strong><\/em>|<em>see <strong[^>]*>this<\/strong><\/em>/);
  });

  it("links a bare http(s) URL, without the punctuation after it", () => {
    const out = html("Docs: https://example.com/a?b=1. Done");
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain("</a>. Done");
    expect(html("[the docs](https://example.com)")).not.toContain("https://example.com</a>");
  });
});
