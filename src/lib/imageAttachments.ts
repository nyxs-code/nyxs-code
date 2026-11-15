import type { AttachedFile } from "@/components/ui/claude-style-chat-input";
import type { ImageAttachment } from "@/lib/ai";
import { MODEL_IMAGE_TYPES } from "@/lib/turnInput";

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const IMAGE_EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** An attachment's image type, from the file or else its extension; "" when it isn't one the
 *  model reads as an image. */
function modelImageMime(f: AttachedFile): string {
  const type = f.file.type.toLowerCase().replace("image/jpg", "image/jpeg");
  if (type) return MODEL_IMAGE_TYPES.has(type) ? type : "";
  return IMAGE_EXT_MIME[f.file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

/** Whether an attachment goes to the model as an image: PNG, JPEG, GIF or WebP. An SVG goes as
 *  its text and HEIC, BMP or TIFF as files (toDocumentAttachments), which every provider takes. */
export function isImageAttachment(f: AttachedFile): boolean {
  return modelImageMime(f) !== "";
}

/** The largest image sent to the model as an image. It is read whole into a data URL (a third
 *  bigger, two bytes a character), and no provider takes more than this anyway; a bigger one is
 *  attached as a file instead (see toDocumentAttachments). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function toImageAttachments(files: AttachedFile[]): Promise<ImageAttachment[]> {
  const images = files.filter((f) => isImageAttachment(f) && f.file.size <= MAX_IMAGE_BYTES);
  return Promise.all(
    images.map(async (f) => ({
      mediaType: modelImageMime(f),
      dataUrl: await fileToDataUrl(f.file),
      name: f.file.name,
    })),
  );
}
