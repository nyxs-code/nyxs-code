import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/cloud/cloudApi", () => {
  class CloudError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    CloudError,
    deleteCloudThread: async (id: string) => {
      calls.push(id);
      if (id === "gone") throw new CloudError("not found", 404);
      if (id === "stuck") throw new CloudError("server error", 500);
      return { ok: true };
    },
  };
});

const { cloudThreadIdsOf, deleteCloudCopies } = await import("../cloudDelete");

const cloud = (id: string) => ({ threadLocation: { kind: "cloud" as const, cloudThreadId: id } });
const local = { threadLocation: { kind: "local" as const, workspace: "C:\\a" } };

describe("deleting cloud threads with their sessions", () => {
  it("finds each cloud thread once, and none in local sessions", () => {
    expect(cloudThreadIdsOf([cloud("a"), local, {}, cloud("a"), cloud("b")])).toEqual(["a", "b"]);
  });

  it("deletes them, counts one already gone as deleted, and stops at the first refusal", async () => {
    expect(await deleteCloudCopies([cloud("a"), cloud("gone"), local])).toBeNull();
    expect(calls).toEqual(["a", "gone"]);
    calls.length = 0;
    expect(await deleteCloudCopies([cloud("stuck"), cloud("b")])).toBe("server error");
    expect(calls).toEqual(["stuck"]);
    expect(await deleteCloudCopies([local])).toBeNull();
  });
});
