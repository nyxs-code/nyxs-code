// Loads a scene module by file name (without extension): the project's own scenes/ first, then
// the built-in nyxs/engine/scenes/ (TitleCard, LowerThird, LogoReveal...).
// This is the webpack version (Remotion render/still), where `@project` is aliased to the project
// folder and template-literal imports become a context of every matching file. nyxs/serve.mjs
// replaces this module for the player with one that lists the files explicitly.
export async function importScene(name: string): Promise<Record<string, unknown>> {
  try {
    return (await import(`@project/scenes/${name}.tsx`)) as Record<string, unknown>;
  } catch (projectError) {
    try {
      return (await import(`./scenes/${name}.tsx`)) as Record<string, unknown>;
    } catch {
      throw projectError;
    }
  }
}
