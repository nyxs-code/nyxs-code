import { invoke } from "@/lib/ipc";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/tools/context";
import { checkGate } from "@/tools/gate";

export function createReadPdfTool(ctx: ToolContext) {
  const { allowPdf, scope, resolve } = ctx;
  return tool({
    description: `Reads a PDF file so you can analyze its text, tables and layout.

Usage:
- Provide the path to a .pdf file (absolute or relative to the working folder).
- The PDF is validated (magic bytes, size). PDFs over ~20MB are rejected; for very large PDFs use a CLI tool via Bash.
- On models with native PDF/vision input (Claude, Gemini…) the document is attached as-is. On other models the text is extracted locally and given to you as plain text (so PDFs work everywhere; scanned/image-only PDFs may yield little text).`,
    inputSchema: z.object({
      file_path: z.string().describe("Path of the PDF file to read."),
    }),
    execute: async ({ file_path }) => {
      const path = resolve(file_path);
      try {
        if (!allowPdf) {
          const text = await invoke<string>("agent_read_pdf_text", { path, scope });
          return { ok: true as const, mode: "text" as const, text, filePath: file_path };
        }
        const out = await invoke<{ base64: string; size: number }>("agent_read_pdf", { path, scope });
        return { ok: true as const, mode: "bytes" as const, base64: out.base64, size: out.size, filePath: file_path };
      } catch (e) {
        return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
      }
    },
    toModelOutput: ({ output }) => {
      if (!output || !output.ok) {
        return { type: "error-text", value: output?.message ?? "Failed to read the PDF." };
      }
      if (output.mode === "text") {
        const body = output.text.trim();
        return {
          type: "content",
          value: [
            {
              type: "text",
              text: body
                ? `Read PDF ${output.filePath} (extracted text below):\n\n${body}`
                : `Read PDF ${output.filePath}, but no extractable text was found (it may be a scanned/image-only PDF).`,
            },
          ],
        };
      }
      const name = output.filePath.split(/[\\/]/).filter(Boolean).pop() ?? "document.pdf";
      const sizeKb = Math.round(output.size / 1024);
      return {
        type: "content",
        value: [
          { type: "text", text: `Read PDF ${output.filePath} (${sizeKb} KB). The document is attached below.` },
          { type: "file-data", data: output.base64, mediaType: "application/pdf", filename: name },
        ],
      };
    },
  });
}

export function createWritePdfTool(ctx: ToolContext) {
  const { gate, scope, resolve, pathInput, trackEdit } = ctx;
  return tool({
    description: `Creates a professional, fully-styled PDF document.

PREFERRED — design it as HTML: pass a complete, self-contained HTML document in \`html\` (all CSS inline in a <style> tag) and it is rendered to PDF by a headless browser, preserving the real design (colors, fonts, layout, backgrounds, gradients, tables). This is how you get a polished, non-plain-text PDF.
- Design for print: use @page { margin } and page sizes (A4/Letter); use \`page-break\`/\`break-inside: avoid\` so sections don't split badly. Self-contained: no external JS; images as data URLs or omitted.

FALLBACK — \`content\` (light Markdown): used only if no browser is available to render HTML, or when you didn't pass \`html\`. Produces a plain, text-only PDF (built-in fonts, no colors). Headings with "# ## ###", bullets "- ", blank lines = paragraphs.

Provide \`html\` for anything that should look designed; use \`content\` only for quick plain documents. To edit existing text files use Edit/Write instead.`,
    inputSchema: z.object({
      file_path: z.string().describe("Path of the PDF to write (should end in .pdf)."),
      html: z.string().optional().describe("A complete self-contained HTML document (with inline CSS) to render to PDF. Preferred for styled output."),
      title: z.string().optional().describe("Document title for the plain-text fallback (used only with `content`)."),
      content: z.string().optional().describe("Plain-text fallback body as light Markdown. Only used when `html` is absent or can't be rendered."),
    }),
    execute: async ({ file_path, html, title, content }) => {
      const resolved = resolve(file_path);
      const denied = await checkGate(gate, "WritePdf", pathInput(file_path, resolved));
      if (denied) return denied;
      await trackEdit(resolved);
      if (html && html.trim()) {
        try {
          return await invoke<string>("agent_html_to_pdf", { outPath: resolved, html, scope });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("no-browser")) {
            return `WritePdf (HTML render) failed: ${msg}`;
          }
          if (!content || !content.trim()) {
            return "WritePdf: no browser (Edge/Chrome) found to render the HTML, and no `content` fallback was provided. Install Edge/Chrome, or call again with a `content` field for a plain-text PDF.";
          }
          const out = await invoke<string>("agent_write_pdf", { path: resolved, title: title ?? null, content, scope });
          return `${out}\n(Note: rendered as plain text — no Edge/Chrome found to render the styled HTML.)`;
        }
      }
      return await invoke<string>("agent_write_pdf", { path: resolved, title: title ?? null, content: content ?? "", scope });
    },
  });
}
