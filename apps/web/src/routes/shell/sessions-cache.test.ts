import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportClientIssue } from "../../lib/report.ts";
import { useSessionsCache } from "./sessions-cache.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const s = (id: string, updatedAt: number) =>
  ({ id, cwd: `/w/${id}`, status: "idle", createdAt: 0, updatedAt }) as const;
beforeEach(() => useSessionsCache.setState({ sessions: [], status: "idle" }));

describe("sessions cache", () => {
  it("sorts newest first and keeps at most 500", async () => {
    const call = vi.fn().mockResolvedValue({
      sessions: Array.from({ length: 600 }, (_, i) => s(String(i), i)),
    });
    await useSessionsCache.getState().refresh({ call } as never);
    const state = useSessionsCache.getState();
    expect([state.sessions.length, state.sessions[0]?.id, state.sessions[499]?.id, state.status]).toEqual([
      500,
      "599",
      "100",
      "loaded",
    ]);
  });

  it("shares one call between concurrent refreshes, and keeps the list when a refresh fails", async () => {
    const call = vi.fn().mockResolvedValue({ sessions: [s("a", 1)] });
    await Promise.all([
      useSessionsCache.getState().refresh({ call } as never),
      useSessionsCache.getState().refresh({ call } as never),
    ]);
    expect(call).toHaveBeenCalledOnce();
    await expect(
      useSessionsCache.getState().refresh({ call: vi.fn().mockRejectedValue(new Error("x")) } as never),
    ).resolves.toBeUndefined();
    expect([useSessionsCache.getState().status, useSessionsCache.getState().sessions.length]).toEqual([
      "error",
      1,
    ]);
    expect(reportClientIssue).toHaveBeenCalledWith("sessions_list_failed");
  });

  it("asks again once the previous refresh has settled", async () => {
    const call = vi.fn().mockResolvedValue({ sessions: [s("a", 1)] });
    await useSessionsCache.getState().refresh({ call } as never);
    await useSessionsCache.getState().refresh({ call } as never);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
