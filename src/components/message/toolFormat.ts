import type { ComponentType } from "react";
import {
  FileText,
  FilePlus,
  Pencil,
  Search,
  FolderSearch,
  Terminal,
  FolderTree,
  Sparkles,
  ScrollText,
  Square,
  Globe,
  Play,
  Bot,
  KeyRound,
  MessageCircleQuestion,
  Film,
  Monitor,
  Clapperboard,
  ImageIcon,
  Captions,
  AudioLines,
  Scissors,
} from "lucide-react";

export const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,
  MultiEdit: Pencil,
  Glob: FolderSearch,
  Grep: Search,
  Bash: Terminal,
  BashOutput: ScrollText,
  KillShell: Square,
  ListDir: FolderTree,
  Skill: Sparkles,
  WebSearch: Search,
  WebFetch: Globe,
  ReadPdf: FileText,
  WritePdf: FilePlus,
  WatchVideo: Film,
  Computer: Monitor,
  Preview: Play,
  Agent: Bot,
  RequestPermission: KeyRound,
  AskUserQuestion: MessageCircleQuestion,
  Video: Clapperboard,
  VideoCreate: Clapperboard,
  VideoStill: ImageIcon,
  VideoRender: Film,
  VideoOpen: Clapperboard,
  VideoCaptions: Captions,
  VideoRemoveSilences: AudioLines,
  VideoCutByTranscript: Scissors,
  VideoImportMedia: FilePlus,
};

const TOOL_TONES: Record<string, string> = {
  Read: "text-sky-500",
  ReadPdf: "text-sky-500",
  WatchVideo: "text-sky-500",
  Write: "text-violet-500",
  WritePdf: "text-violet-500",
  Edit: "text-violet-500",
  MultiEdit: "text-violet-500",
  Glob: "text-blue-500",
  Grep: "text-blue-500",
  ListDir: "text-blue-500",
  WebSearch: "text-indigo-500",
  WebFetch: "text-indigo-500",
  retrieve_context: "text-indigo-500",
  ToolSearch: "text-slate-500",
  Bash: "text-amber-500",
  BashOutput: "text-amber-500",
  KillShell: "text-amber-500",
  GitStatus: "text-orange-500",
  GitDiff: "text-orange-500",
  GitLog: "text-orange-500",
  GitBlame: "text-orange-500",
  Lsp: "text-teal-500",
  Preview: "text-emerald-500",
  Computer: "text-emerald-500",
  Skill: "text-fuchsia-500",
  Agent: "text-pink-500",
  TaskCreate: "text-pink-500",
  RequestPermission: "text-yellow-600",
  AskUserQuestion: "text-yellow-600",
  Video: "text-rose-500",
  VideoCreate: "text-rose-500",
  VideoStill: "text-rose-500",
  VideoRender: "text-rose-500",
  VideoOpen: "text-rose-500",
  VideoCaptions: "text-rose-500",
  VideoRemoveSilences: "text-rose-500",
  VideoCutByTranscript: "text-rose-500",
  VideoImportMedia: "text-rose-500",
};

export function toolTone(name: string): string {
  return TOOL_TONES[name] ?? "text-text-400";
}

/** Tools whose rows are a change to one file, so consecutive ones on the same file merge. */
export const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

export const PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "ListDir", "Preview", "ReadPdf", "WritePdf", "WatchVideo"]);

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function cleanCommand(cmd: string): string {
  let out = cmd.trim();
  const cdPrefix = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i;
  while (cdPrefix.test(out)) out = out.replace(cdPrefix, "");
  return out || cmd;
}

export function compactCommand(cmd: string): string {
  const tokens = cleanCommand(cmd).split(/\s+/).filter(Boolean).map((t) => t.replace(/@[^@\s]+$/, ""));
  if (tokens.length === 0) return cleanCommand(cmd);
  const head = tokens.slice(0, 2).join(" ").replace(/[;&|]+$/, "");
  return tokens.length > 2 ? `${head} …` : head;
}

export const TOOL_VERBS: Record<string, [string, string]> = {
  Read: ["Reading", "Read"],
  Write: ["Writing", "Wrote"],
  Edit: ["Editing", "Edited"],
  MultiEdit: ["Editing", "Edited"],
  Glob: ["Searching", "Found"],
  Grep: ["Searching", "Searched"],
  Bash: ["Running", "Ran"],
  BashOutput: ["Reading output", "Read output"],
  KillShell: ["Stopping", "Stopped"],
  ListDir: ["Listing", "Listed"],
  Skill: ["Running", "Ran"],
  WebSearch: ["Searching the web", "Web search"],
  WebFetch: ["Fetching", "Fetched"],
  ReadPdf: ["Reading PDF", "Read PDF"],
  WritePdf: ["Creating PDF", "Created PDF"],
  WatchVideo: ["Watching video", "Watched video"],
  Computer: ["Using the computer", "Used the computer"],
  Preview: ["Opening preview", "Preview"],
  Agent: ["Exploring", "Explored"],
  RequestPermission: ["Requesting permission", "Permission requested"],
  AskUserQuestion: ["Asking", "Asked"],
  Video: ["Editing video", "Edited video"],
  VideoCreate: ["Creating video", "Created video"],
  VideoStill: ["Rendering frames", "Rendered frames"],
  VideoRender: ["Rendering video", "Rendered video"],
  VideoOpen: ["Opening video", "Opened video"],
  VideoCaptions: ["Generating captions", "Generated captions"],
  VideoRemoveSilences: ["Removing silences", "Removed silences"],
  VideoCutByTranscript: ["Cutting by transcript", "Cut by transcript"],
  VideoImportMedia: ["Importing media", "Imported media"],
};

export const MIN_RUNNING_MS = 700;
