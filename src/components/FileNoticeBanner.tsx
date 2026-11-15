import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "@/lib/i18n";
import {
  baseName,
  currentFileNotice,
  dismissFileNotice,
  openNoticeFolder,
  subscribeFileNotices,
  type FileNotice,
} from "@/lib/fileNotices";
import { NoticeCard } from "@/components/NoticeCard";
import { Button } from "@/components/ui/button";

/** `text` with `{file}` replaced by the file's name in monospace. */
function withFile(text: string, path: string): ReactNode {
  const [before, after] = text.split("{file}");
  if (after === undefined) return text;
  return (
    <>
      {before}
      <code className="font-mono text-[12px] text-text-200">{baseName(path)}</code>
      {after}
    </>
  );
}

/** Says when a data file couldn't be read and was left alone (see lib/fileNotices). */
export function FileNoticeBanner() {
  const t = useTranslations();
  const tn = t.fileNotices;
  const notice = useSyncExternalStore(subscribeFileNotices, currentFileNotice);
  if (!notice) return null;

  const { title, body, folder } = describe(notice, tn);
  return (
    <NoticeCard
      tone="warning"
      title={title}
      body={body}
      closeLabel={t.announcements.close}
      onClose={dismissFileNotice}
      action={
        notice.kind === "rewindFailed" ? (
          // As the "left as they are" list of RewindDialog.
          <ul className="max-h-28 overflow-y-auto custom-scrollbar rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-text-300">
            {notice.files.map((p) => (
              <li key={p} className="break-all">{p}</li>
            ))}
          </ul>
        ) : folder ? (
          <Button
            onClick={() => {
              void openNoticeFolder(folder).catch((e: unknown) => console.warn("[fileNotices] couldn't open the folder:", e));
            }}
          >
            {tn.openFolder}
          </Button>
        ) : undefined
      }
    />
  );
}

function describe(
  notice: FileNotice,
  tn: ReturnType<typeof useTranslations>["fileNotices"],
): { title: ReactNode; body: ReactNode; folder: string | null } {
  switch (notice.kind) {
    case "unreadableFile":
      return {
        title: tn.unreadableFileTitle.replace("{file}", baseName(notice.file)),
        body: (
          <>
            {tn.unreadableFileBody}
            {notice.backup && <> {withFile(tn.unreadableFileBackup, notice.backup)}</>}
          </>
        ),
        folder: notice.folder,
      };
    case "unreadableSession":
      return { title: tn.sessionTitle, body: tn.sessionBody, folder: notice.folder };
    case "chatIndexSetAside":
      return { title: tn.chatIndexTitle, body: withFile(tn.chatIndexBody, notice.file), folder: notice.folder };
    case "rewindFailed":
      return {
        title: notice.files.length === 1 ? tn.rewindFailedTitleOne : tn.rewindFailedTitle.replace("{n}", String(notice.files.length)),
        body: tn.rewindFailedBody,
        folder: null,
      };
  }
}
