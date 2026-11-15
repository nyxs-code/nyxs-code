// Stand-in for ./sceneLoader when a bundle has no `@project` alias (e.g. rendering timeline
// compositions through an adopted project's own webpack setup): only built-in scenes load.
export async function importScene(name: string): Promise<Record<string, unknown>> {
  return (await import(`./scenes/${name}.tsx`)) as Record<string, unknown>;
}
