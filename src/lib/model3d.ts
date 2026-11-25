/** 3D models the Files panel shows in its 3D view (ModelView.tsx). */
export const MODEL_EXT = /\.(glb|gltf|stl|obj)$/i;

export type ModelFormat = "glb" | "gltf" | "stl" | "obj";

export function modelFormat(path: string): ModelFormat | null {
  const m = MODEL_EXT.exec(path);
  return m ? (m[1].toLowerCase() as ModelFormat) : null;
}

/** A .gltf whose buffers or textures are other files (`scene.bin`, `texture.png`): the view only
 *  gets this one file, so it can't draw it. Embedded `data:` URIs are fine. */
export function gltfNeedsOtherFiles(json: string): boolean {
  try {
    const doc = JSON.parse(json) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    return [...(doc.buffers ?? []), ...(doc.images ?? [])].some((b) => typeof b.uri === "string" && !b.uri.startsWith("data:"));
  } catch {
    return false;
  }
}

/** "12,480 triangles · 2.4 × 1.1 × 0.8": the model's size in its own units. */
export function modelInfo(triangles: number, size: { x: number; y: number; z: number }, lang: string, template: string): string {
  const n = new Intl.NumberFormat(lang);
  const d = new Intl.NumberFormat(lang, { maximumSignificantDigits: 3 });
  return template
    .replace("{triangles}", n.format(Math.round(triangles)))
    .replace("{width}", d.format(size.x))
    .replace("{height}", d.format(size.y))
    .replace("{depth}", d.format(size.z));
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
