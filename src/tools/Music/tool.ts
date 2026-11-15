import { tool } from "ai";
import { z } from "zod";
import {
  ensureLibrary,
  findLocalTrack,
  getMusicState,
  next,
  nowPlaying,
  pause,
  playOnYouTube,
  playTrack,
  previous,
  resume,
  setMuted,
  setVolume,
} from "@/lib/music/player";

export const MUSIC_MCP_SERVER = "nyxs-music";
export const MUSIC_MCP_TOOL = "music";

export const MUSIC_DESCRIPTION = `Play and control music for the user in Nyxs' player (the one in the title bar). Use it when the user asks to play, pause, skip or change the volume of music, or asks what is playing. Don't use the browser or the desktop for that.
- action "play" needs a query: the song, artist or mood as the user would search it ("Nosotros Anuel AA", "lofi para estudiar"). It starts the first result and answers with what is really playing, so tell the user that, not what you asked for.
- service picks where to search: "youtube_music", "local" (the user's music folder), or "auto" (default: YouTube Music when connected, otherwise the folder).
- "pause", "resume", "next" and "previous" act on whatever the player is showing, also a song in another app.
- "set_volume" needs volume, from 0 to 100; "mute" and "unmute" silence it and bring it back. They work on YouTube Music and the folder; Windows doesn't let Nyxs change another app's volume.
- "status" says what is playing and which services are connected.
If a service isn't connected, say so and point the user to Settings > Music; never try to sign in for them.`;

export const musicInputSchema = z.object({
  action: z.enum(["play", "pause", "resume", "next", "previous", "set_volume", "mute", "unmute", "status"]),
  query: z.string().optional().describe('What to search for, for "play".'),
  service: z.enum(["auto", "youtube_music", "local"]).optional().describe('Where to search, for "play". Default "auto".'),
  volume: z.number().min(0).max(100).optional().describe('From 0 to 100, for "set_volume".'),
});

export type MusicInput = z.infer<typeof musicInputSchema>;
export type MusicOutput = { ok: boolean; text: string };

const fail = (text: string): MusicOutput => ({ ok: false, text });
const done = (text: string): MusicOutput => ({ ok: true, text });
const NOT_CONNECTED = "YouTube Music isn't connected. The user can connect it in Settings > Music.";

function describe(title: string, artist: string | null): string {
  return artist ? `"${title}" by ${artist}` : `"${title}"`;
}

function status(): string {
  const s = getMusicState();
  const now = nowPlaying(s);
  const playing = now
    ? `${now.playing ? "Playing" : "Paused"}: ${describe(now.title, now.artist)}${now.appId ? ` in ${now.appId}` : ""}.`
    : "Nothing is playing.";
  const sources = [`YouTube Music ${s.youtubeConnected ? "connected" : "not connected"}`, s.folder ? `music folder with ${s.tracks.length} songs` : "no music folder"];
  return `${playing} ${sources.join(", ")}. Volume ${Math.round(s.volume * 100)}${s.muted ? " (muted)" : ""}.`;
}

async function playLocal(query: string): Promise<MusicOutput> {
  await ensureLibrary();
  const s = getMusicState();
  if (!s.folder) return fail("There is no music folder. The user can choose one in Settings > Music.");
  const index = findLocalTrack(s.tracks, query);
  if (index < 0) return fail(`Nothing in the music folder matches "${query}".`);
  await playTrack(index);
  const after = getMusicState();
  if (after.playFailed) return fail(`Couldn't play "${s.tracks[index].title}".`);
  return done(`Playing ${describe(s.tracks[index].title, s.tracks[index].artist)} from the music folder.`);
}

async function playYouTube(query: string): Promise<MusicOutput> {
  try {
    const playing = await playOnYouTube(query);
    return done(`Playing ${describe(playing.title ?? query, playing.artist)} on YouTube Music.`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function play(query: string | undefined, service: MusicInput["service"]): Promise<MusicOutput> {
  const q = query?.trim();
  if (!q) return fail('"play" needs a query.');
  const connected = getMusicState().youtubeConnected;
  if (service === "local") return playLocal(q);
  if (service === "youtube_music") return connected ? playYouTube(q) : fail(NOT_CONNECTED);
  if (connected) return playYouTube(q);
  const local = await playLocal(q);
  return local.ok ? local : fail(`${local.text} ${NOT_CONNECTED}`);
}

/** The tool's work, shared by the built-in models and the CLI agents' MCP server. */
export async function runMusic(input: MusicInput): Promise<MusicOutput> {
  await ensureLibrary();
  const hasMusic = () => !!nowPlaying(getMusicState());
  switch (input.action) {
    case "play":
      return play(input.query, input.service);
    case "status":
      return done(status());
    case "set_volume":
      if (input.volume === undefined) return fail('"set_volume" needs volume.');
      setVolume(input.volume / 100);
      return done(`Volume set to ${Math.round(input.volume)}.`);
    case "mute":
      setMuted(true);
      return done("Muted.");
    case "unmute":
      setMuted(false);
      return done("Unmuted.");
    case "pause":
      if (!hasMusic()) return fail("Nothing is playing.");
      pause();
      return done("Paused.");
    case "resume":
      if (!hasMusic()) return fail("There is nothing to resume.");
      resume();
      return done("Resumed.");
    case "next":
      if (!hasMusic()) return fail("Nothing is playing.");
      next();
      return done("Skipped to the next song.");
    case "previous":
      if (!hasMusic()) return fail("Nothing is playing.");
      previous();
      return done("Went back.");
  }
}

export function createMusicTool() {
  return tool({
    description: MUSIC_DESCRIPTION,
    inputSchema: musicInputSchema,
    execute: async (input) => {
      const out = await runMusic(input);
      return out.ok ? out.text : `Error: ${out.text}`;
    },
  });
}
