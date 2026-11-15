import { BASH_TOOL_NAME } from "../toolNames";
import { DEFAULT_FRAMES, MAX_FRAMES } from "./frames";

export function getWatchVideoDescription(): string {
  return `Watches a video file (.mp4, .mov, .webm, .mkv, .avi, ...) so you can see what happens in it.

Usage:
- Provide the path to the video (absolute or relative to the working folder). Videos the user attaches are saved to a path you can pass here.
- On a model that takes video natively (Gemini, Qwen, MiniMax M3, Kimi...), mode "auto" sends you the whole video, up to 20 MB, and you watch it directly, sound included where the model hears audio.
- Otherwise, or with mode "frames", you get still frames taken evenly across the video (${DEFAULT_FRAMES} by default, up to ${MAX_FRAMES}), each with its timestamp. Frames show no motion between them and carry no sound.
- To look closer at a moment, call it again with start and end (in seconds) around it and more frames. Passing start, end or frames always gives frames.
- If the format can't be decoded, convert it with ffmpeg through ${BASH_TOOL_NAME} (for example \`ffmpeg -i in.avi -c:v libx264 -an out.mp4\`) and watch the result. ffmpeg also cuts a shorter clip from a video too big to send whole (\`ffmpeg -ss 60 -t 30 -i in.mp4 -c copy clip.mp4\`).`;
}
