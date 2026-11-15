import { Captions, Code2, Film, Image, Music, Square, Type } from "lucide-react";
import type { Asset, ClipType } from "@/lib/video/timelineSchema";

/** The icon of a clip type, or of a media asset kind (fonts get the text icon). */
export function ClipIcon({ type, className }: { type: ClipType | Asset["kind"]; className?: string }) {
  switch (type) {
    case "video":
      return <Film className={className} />;
    case "image":
      return <Image className={className} />;
    case "audio":
      return <Music className={className} />;
    case "text":
    case "font":
      return <Type className={className} />;
    case "scene":
      return <Code2 className={className} />;
    case "captions":
      return <Captions className={className} />;
    default:
      return <Square className={className} />;
  }
}
