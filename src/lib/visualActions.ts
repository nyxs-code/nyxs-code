import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/ipc";

function fileNameOf(title: string): string {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "elemento-visual"}.html`;
}

/** Copies what `box` shows to the clipboard as a picture; answers whether it worked. */
export async function copyVisualImage(box: HTMLElement): Promise<boolean> {
  box.scrollIntoView({ block: "nearest" });
  // Let the menu close and the scroll settle: the picture is taken from the screen.
  await new Promise((r) => setTimeout(r, 180));
  const r = box.getBoundingClientRect();
  try {
    const png = await invoke<string>("preview_capture_png", { x: r.left, y: r.top, width: r.width, height: r.height });
    const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** Saves a visual as an HTML file where the user chooses; answers false only if writing failed. */
export async function saveVisualHtml(id: string, title: string): Promise<boolean> {
  const path = await saveDialog({ defaultPath: fileNameOf(title), filters: [{ name: "HTML", extensions: ["html"] }] }).catch(() => null);
  if (!path) return true;
  return invoke("preview_mockup_save", { id, path }).then(() => true, () => false);
}
