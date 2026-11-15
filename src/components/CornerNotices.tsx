import { AnnouncementsBanner } from "@/components/AnnouncementsBanner";
import { FileNoticeBanner } from "@/components/FileNoticeBanner";
import { ModToasts } from "@/components/mods/ModToasts";

/** The notices in the bottom-right corner, stacked so one never covers another. */
export function CornerNotices() {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 [&>*]:pointer-events-auto">
      <AnnouncementsBanner />
      <FileNoticeBanner />
      <ModToasts />
    </div>
  );
}
