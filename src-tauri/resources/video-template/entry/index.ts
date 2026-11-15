// Remotion entry of the video runtime for light projects (timeline.json + scenes/ + media/).
// nyxs/render.mjs bundles it with `@project` aliased to the project folder.
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
