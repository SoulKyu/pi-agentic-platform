// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { mount } from "../../testing/dom.ts";
import { previewView, PROJECT_BOX } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { usePreviewLease } from "./use-preview-lease.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const LEASE = (n: number) => String(n).repeat(32);
type Lease = ReturnType<typeof usePreviewLease>;

let bed: ReturnType<typeof fakeRuntime>;
let leaseNow: Lease;
let opens: number;

function Probe({ armed }: { readonly armed: boolean }) {
  const lease = usePreviewLease(PROJECT_BOX, "web", armed);
  useEffect(() => {
    leaseNow = lease;
  });
  return <p data-state={lease.state}>{lease.url}</p>;
}

const answerOpen = () => {
  opens += 1;
  return { url: `https://p.example/p/tok${opens}/`, lease: LEASE(opens), leaseMs: 300_000 };
};

beforeEach(() => {
  vi.useFakeTimers();
  opens = 0;
  bed = fakeRuntime();
  bed.handlers["previews.open"] = answerOpen;
  bed.handlers["previews.renew"] = () => ({ until: 1 });
  bed.handlers["previews.close"] = () => ({});
  current.runtime = bed.runtime;
  usePreviewsStore.getState().reset();
  usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView()] });
});

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("usePreviewLease", () => {
  it("an unarmed hook never calls previews.open", async () => {
    await mount(<Probe armed={false} />);
    await tick(10 * 60_000);
    expect(bed.called("previews.open")).toHaveLength(0);
    expect(leaseNow.state).toBe("closed");
  });

  it("an armed mount opens once, with a command id, and gives the URL", async () => {
    await mount(<Probe armed />);
    await tick(0);
    expect(bed.called("previews.open")).toHaveLength(1);
    expect(bed.called("previews.open")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(bed.called("previews.open")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(leaseNow.state).toBe("open");
    expect(leaseNow.url).toBe("https://p.example/p/tok1/");
  });

  it("open() mints on the owner's click when the hook was not armed", async () => {
    await mount(<Probe armed={false} />);
    await act(async () => leaseNow.open());
    expect(bed.called("previews.open")).toHaveLength(1);
    expect(leaseNow.state).toBe("open");
  });

  it("renews its lease every 60 s", async () => {
    await mount(<Probe armed />);
    await tick(0);
    await tick(59_000);
    expect(bed.called("previews.renew")).toHaveLength(0);
    await tick(1_000);
    expect(bed.called("previews.renew")).toHaveLength(1);
    expect(bed.called("previews.renew")[0]?.params).toEqual({ lease: LEASE(1) });
    await tick(120_000);
    expect(bed.called("previews.renew")).toHaveLength(3);
  });

  it("closes its lease at unmount and stops renewing", async () => {
    const page = await mount(<Probe armed />);
    await tick(0);
    await page.unmount();
    expect(bed.called("previews.close")).toHaveLength(1);
    expect(bed.called("previews.close")[0]?.params).toEqual({ lease: LEASE(1) });
    await tick(5 * 60_000);
    expect(bed.called("previews.renew")).toHaveLength(0);
  });

  it("a failed close is logged once as a stable code, never thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bed.handlers["previews.close"] = () => {
      throw new RpcError("offline");
    };
    const page = await mount(<Probe armed />);
    await tick(0);
    await page.unmount();
    await tick(0);
    expect(warn).toHaveBeenCalledWith("pap: preview_close_failed");
    warn.mockRestore();
  });

  it("a renew refused for another reason is logged, reported to the pane, and cleared by the next good one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    bed.handlers["previews.renew"] = () => {
      if (fail) throw new RpcError("connection_lost");
      return { until: 1 };
    };
    await mount(<Probe armed />);
    await tick(0);
    await tick(60_000);
    expect(leaseNow.lost).toBe("connection_lost");
    expect(leaseNow.state).toBe("open");
    expect(warn).toHaveBeenCalledWith("pap: preview_renew_failed");
    fail = false;
    await tick(60_000);
    expect(leaseNow.lost).toBeNull();
    warn.mockRestore();
  });

  it("re-opens once on not_found while the same service id still runs", async () => {
    bed.handlers["previews.renew"] = () => {
      throw new RpcError("not_found");
    };
    await mount(<Probe armed />);
    await tick(0);
    await tick(60_000);
    expect(bed.called("previews.open")).toHaveLength(2);
    expect(leaseNow.state).toBe("open");
    expect(leaseNow.url).toBe("https://p.example/p/tok2/");
  });

  it("a restart under a new id shows restarted and opens nothing", async () => {
    bed.handlers["previews.renew"] = () => {
      throw new RpcError("not_found");
    };
    await mount(<Probe armed />);
    await tick(0);
    act(() => {
      usePreviewsStore
        .getState()
        .apply({ type: "service", service: previewView({ id: "b".repeat(32), startedAt: 2 }) });
    });
    await tick(60_000);
    expect(leaseNow.state).toBe("restarted");
    expect(leaseNow.url).toBeNull();
    expect(bed.called("previews.open")).toHaveLength(1);
  });

  it("a renew refused as not_found when the service is gone shows gone", async () => {
    bed.handlers["previews.renew"] = () => {
      throw new RpcError("not_found");
    };
    await mount(<Probe armed />);
    await tick(0);
    usePreviewsStore.setState({ services: new Map() });
    await tick(60_000);
    expect(leaseNow.state).toBe("gone");
    expect(leaseNow.url).toBeNull();
    expect(bed.called("previews.open")).toHaveLength(1);
  });

  it("the stream removing the service shows gone at once", async () => {
    await mount(<Probe armed />);
    await tick(0);
    act(() => usePreviewsStore.getState().apply({ type: "removed", box: PROJECT_BOX, name: "web" }));
    expect(leaseNow.state).toBe("gone");
  });

  it("a refused open leaves the code as the error and no URL", async () => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("box_stopped");
    };
    await mount(<Probe armed />);
    await tick(0);
    expect(leaseNow.state).toBe("closed");
    expect(leaseNow.error).toBe("box_stopped");
    expect(leaseNow.url).toBeNull();
  });

  it("not_found on open is the gone state", async () => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("not_found");
    };
    await mount(<Probe armed />);
    await tick(0);
    expect(leaseNow.state).toBe("gone");
  });

  it("reload keeps the lease and counts a reload", async () => {
    await mount(<Probe armed />);
    await tick(0);
    const before = leaseNow.reloads;
    act(() => leaseNow.reload());
    expect(leaseNow.reloads).toBe(before + 1);
    expect(bed.called("previews.open")).toHaveLength(1);
  });
});
