/** An SVG's text as an image address: drawn as a picture, it runs no script and loads nothing. */
export function svgSource(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}
