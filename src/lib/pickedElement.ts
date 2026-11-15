import type { ImageAttachment } from "@/lib/turnInput";

/** An element picked in the browser panel, as the chat shows it and the model reads it. The
 *  fields after `html` come from the page's bridge (agent/preview_agent.js); messages saved
 *  before them don't have them. */
export interface PickedElement {
  selector: string;
  /** Which node of the page this was, while it lives. The selector is only tag and classes, so
   *  two elements of a dialog box can share it and still be different picks. */
  uid?: string;
  path: string;
  text: string;
  html: string;
  /** Tag name, lower case ("span"). */
  tag?: string;
  /** A few computed styles that shape it (display, size, colors, borders…). */
  styles?: Record<string, string>;
  /** The HTML of the siblings around it, with `<!-- SELECTED -->` before it. */
  siblings?: string;
  /** Where it was in the page's viewport, in CSS pixels (for the screenshot). */
  rect?: { x: number; y: number; width: number; height: number };
  /** PNG data URL of the page area around it. */
  screenshot?: string;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A picked element from a page's message, keeping only well-formed fields. */
export function toPickedElement(raw: unknown): PickedElement | null {
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d.selector !== "string" || !d.selector) return null;
  const el: PickedElement = { selector: str(d.selector, 300), path: str(d.path, 1000), text: str(d.text, 300), html: str(d.html, 2000) };
  if (typeof d.uid === "string" && d.uid) el.uid = d.uid.slice(0, 40);
  if (typeof d.tag === "string" && /^[a-z][\w-]*$/i.test(d.tag)) el.tag = d.tag.toLowerCase();
  if (d.styles && typeof d.styles === "object") {
    const styles: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.styles as Record<string, unknown>).slice(0, 40)) if (typeof v === "string") styles[k] = v.slice(0, 120);
    if (Object.keys(styles).length) el.styles = styles;
  }
  if (typeof d.siblings === "string" && d.siblings) el.siblings = d.siblings.slice(0, 4000);
  const r = d.rect as Record<string, unknown> | undefined;
  if (r && [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
    el.rect = { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
  }
  return el;
}

/** "<span />" for the chip and its card. */
export function elementTagLabel(el: PickedElement): string {
  const tag = el.tag ?? el.selector.match(/^[a-z][\w-]*/i)?.[0]?.toLowerCase() ?? "element";
  return `<${tag} />`;
}

/** The picked elements of a message. Messages saved before several could be picked carry a
 *  single `element`. */
export function pickedElementsOf(m: { element?: PickedElement; elements?: PickedElement[] }): PickedElement[] {
  if (m.elements?.length) return m.elements;
  return m.element ? [m.element] : [];
}

/** Picks are kept one per element: picking the same one twice only refreshes its reading. Two
 *  elements that share the selector (fields of a dialog box) are separate picks, so the page's
 *  node id decides when it has one; pages that predate it fall back to the selector. */
export function addPickedElement(list: PickedElement[], el: PickedElement): PickedElement[] {
  const same = (e: PickedElement) => (e.uid && el.uid ? e.uid === el.uid : e.selector === el.selector);
  return [...list.filter((e) => !same(e)), el];
}

const shotName = (i: number, count: number) => (count === 1 ? "elemento.png" : `elemento-${i + 1}.png`);

function formatOne(el: PickedElement, shot: string | null): string {
  const lines = [`Elemento: ${el.selector}`, `Ruta: ${el.path}`];
  if (el.text) lines.push(`Texto: ${el.text}`);
  if (el.styles) lines.push(`Estilos calculados: ${Object.entries(el.styles).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  lines.push("```html", el.html, "```");
  if (el.siblings) lines.push("Hermanos:", "```html", el.siblings, "```");
  if (shot) lines.push(shot);
  return lines.join("\n");
}

/** What the model reads of the picked elements, before the message. Empty when there are none. */
export function formatPickedElements(els: PickedElement[]): string {
  if (els.length === 1) return formatOne(els[0], els[0].screenshot ? "(Se adjunta una captura de la zona del elemento.)" : null);
  return els
    .map((el, i) => `[${i + 1}/${els.length}]\n${formatOne(el, el.screenshot ? `(Captura adjunta: ${shotName(i, els.length)})` : null)}`)
    .join("\n\n");
}

/** The model's text with the picked elements in front. */
export function withPickedElements(text: string, els: PickedElement[]): string {
  return els.length ? `${formatPickedElements(els)}\n\n${text}` : text;
}

/** The message's images plus the picked elements' screenshots, for the model. */
export function withElementShots(images: ImageAttachment[] | undefined, els: PickedElement[]): ImageAttachment[] | undefined {
  const shots = els.flatMap((el, i) => (el.screenshot ? [{ mediaType: "image/png", dataUrl: el.screenshot, name: shotName(i, els.length) }] : []));
  return shots.length ? [...(images ?? []), ...shots] : images;
}
