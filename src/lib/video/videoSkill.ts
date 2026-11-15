import type { SkillDef } from "@/lib/skills";
import body from "./skill/video.md?raw";

/** The built-in `video` skill: how the agent makes and edits Nyxs Video projects. A project or
 *  user skill with the same name replaces it. */
export const VIDEO_SKILL: SkillDef = {
  name: "video",
  dir: "",
  source: "builtin",
  description:
    "Make videos and edit the user's footage with Nyxs Video (Remotion): the video tools, the document's schema, cuts, silences, captions, music ducking, custom React scenes, design and pacing, and the snapshot → act → screenshot → fix loop on the live editor.",
  whenToUse:
    "When the user asks to create, edit, cut, trim, caption or render a video (including their own footage or an existing Remotion project), animation, reel, short, intro, explainer or motion graphic, or mentions a project in videos/.",
  body: body.trim(),
};
