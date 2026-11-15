import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { looksLikeText, toDocumentAttachments, withDocuments, formatFileSize, MAX_INLINE_CHARS } = await import("@/lib/fileAttachments");

const attach = (name: string, body: BlobPart, type = "") => ({
  id: name,
  file: new File([body], name, { type }),
  type: type || "application/octet-stream",
  preview: null,
  uploadStatus: "complete",
});

describe("looksLikeText", () => {
  it("accepts text by type, extension or content and rejects binary", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(looksLikeText("a.bin", "text/plain", new Uint8Array([0]))).toBe(true);
    expect(looksLikeText("notes.md", "", new Uint8Array([0]))).toBe(true);
    expect(looksLikeText("Makefile", "", bytes("all:\n\techo hola ñandú"))).toBe(true);
    expect(looksLikeText("data.bin", "", new Uint8Array([0x25, 0x50, 0x00, 0x01]))).toBe(false);
    expect(looksLikeText("x.dat", "", new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
  });
});

describe("toDocumentAttachments", () => {
  it("reads text files, skips images and saves binaries for the agent", async () => {
    const save = vi.fn(async (name: string) => `C:\\Users\\u\\.nyxs\\attachments\\1\\${name}`);
    const docs = await toDocumentAttachments(
      [
        attach("Nuevo Texto.txt", "hola desde el archivo", "text/plain"),
        attach("foto.png", "png", "image/png"),
        attach("informe.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]), "application/pdf"),
      ] as never,
      save,
    );
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ name: "Nuevo Texto.txt", text: "hola desde el archivo", size: 21 });
    expect(docs[1]).toMatchObject({ name: "informe.pdf", path: "C:\\Users\\u\\.nyxs\\attachments\\1\\informe.pdf" });
    expect(save).toHaveBeenCalledWith("informe.pdf", "JVBERgA=");
  });

  it("cuts very long text files and keeps going when a save fails", async () => {
    const docs = await toDocumentAttachments(
      [attach("big.log", "x".repeat(MAX_INLINE_CHARS + 10)), attach("a.zip", new Uint8Array([0x50, 0x4b, 0x00]))] as never,
      async () => {
        throw new Error("disk full");
      },
    );
    expect(docs[0].text).toHaveLength(MAX_INLINE_CHARS);
    expect(docs[0].truncated).toBe(true);
    expect(docs[1].path).toBeUndefined();
  });
});

describe("withDocuments", () => {
  it("adds each document after the message so the model can see it", () => {
    const out = withDocuments("resume esto", [
      { name: 'a "b".txt', size: 4, mime: "text/plain", text: "hola" },
      { name: "r.pdf", size: 9, mime: "application/pdf", path: "C:\\x\\r.pdf" },
      { name: "z.bin", size: 2, mime: "application/octet-stream" },
    ]);
    expect(out.startsWith("resume esto\n\n<attached-file")).toBe(true);
    expect(out).toContain('name="a &quot;b&quot;.txt"');
    expect(out).toContain(">\nhola\n</attached-file>");
    expect(out).toContain('path="C:\\x\\r.pdf"');
    expect(out).toContain("open it with ReadPdf");
    expect(out).toContain("could not be saved");
    expect(withDocuments("solo texto", undefined)).toBe("solo texto");
    expect(withDocuments("", [{ name: "n.txt", size: 1, mime: "text/plain", text: "y" }]).startsWith("<attached-file")).toBe(true);
  });

  it("formats sizes like the composer card", () => {
    expect(formatFileSize(40)).toBe("40 Bytes");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(0)).toBe("0 Bytes");
  });
});

// A file of a few hundred MB, read whole and turned into base64 to be saved, asked WebView2
// for gigabytes at once and crashed the app (0xE0000008, out of memory).
const { MAX_ATTACHMENT_BYTES } = await import("@/lib/fileAttachments");
const { MAX_IMAGE_BYTES, toImageAttachments } = await import("@/lib/imageAttachments");

describe("large attachments", () => {
  /** A file that says it is `size` bytes long without holding them, and fails if read whole. */
  const huge = (name: string, size: number, type = "application/octet-stream") => {
    const f = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], name, { type });
    Object.defineProperty(f, "size", { value: size });
    f.arrayBuffer = () => Promise.reject(new Error("read whole"));
    return { id: name, file: f, type, preview: null, uploadStatus: "complete" };
  };

  it("doesn't read or save a file over the limit, and tells the model why", async () => {
    const save = vi.fn(async () => "C:/saved/movie.mp4");
    const [doc] = await toDocumentAttachments([huge("movie.mp4", MAX_ATTACHMENT_BYTES + 1, "video/mp4")] as never, save);
    expect(doc.tooLarge).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(withDocuments("", [doc])).toMatch(/over the 50 MB limit/);
  });

  it("reads only the start of a long text file", async () => {
    const [doc] = await toDocumentAttachments([attach("big.log", "a".repeat(MAX_INLINE_CHARS * 5), "text/plain")] as never);
    expect(doc.text).toHaveLength(MAX_INLINE_CHARS);
    expect(doc.truncated).toBe(true);
  });

  it("saves a binary file of several chunks with its base64 intact", async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const save = vi.fn(async (_name: string, data: string) => (atob(data).length === bytes.length ? "ok" : "bad"));
    const [doc] = await toDocumentAttachments([attach("data.bin", bytes)] as never, save);
    expect(doc.path).toBe("ok");
  });

  it("attaches an image too big to send as one as a file, without reading a huge one", async () => {
    expect(await toImageAttachments([huge("photo.png", MAX_IMAGE_BYTES + 1, "image/png")] as never)).toEqual([]);
    const [doc] = await toDocumentAttachments([huge("scan.png", MAX_ATTACHMENT_BYTES + 1, "image/png")] as never);
    expect(doc.tooLarge).toBe(true);
  });
});
