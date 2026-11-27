import { THREAD_STATUSES, type ProjectSessionFields, type ThreadLocation, type ThreadStatus } from "./types";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function location(v: unknown): ThreadLocation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind === "local" && str(o.workspace)) return { kind: "local", workspace: o.workspace as string, ...(str(o.worktree) ? { worktree: o.worktree as string } : {}) };
  if (o.kind === "cloud" && str(o.cloudThreadId)) return { kind: "cloud", cloudThreadId: o.cloudThreadId as string };
  return undefined;
}

/** The project fields of a chat or a saved meta, only those set and well formed: written into
 *  every save and read back from disk, so a session that isn't a project's carries none. */
export function projectFieldsOf(o: ProjectSessionFields | Record<string, unknown> | null | undefined): ProjectSessionFields {
  if (!o) return {};
  const r = o as Record<string, unknown>;
  const projectId = str(r.projectId);
  if (!projectId) return {};
  const role = r.projectRole === "coordinator" || r.projectRole === "thread" ? r.projectRole : undefined;
  const status = THREAD_STATUSES.includes(r.threadStatus as ThreadStatus) ? (r.threadStatus as ThreadStatus) : undefined;
  const loc = location(r.threadLocation);
  return {
    projectId,
    ...(role ? { projectRole: role } : {}),
    ...(status ? { threadStatus: status } : {}),
    ...(str(r.threadTitle) ? { threadTitle: r.threadTitle as string } : {}),
    ...(loc ? { threadLocation: loc } : {}),
    ...(str(r.parentMessageId) ? { parentMessageId: r.parentMessageId as string } : {}),
    ...(str(r.threadPreview) ? { threadPreview: r.threadPreview as string } : {}),
    ...(typeof r.threadUpdatedAt === "number" ? { threadUpdatedAt: r.threadUpdatedAt } : {}),
  };
}
