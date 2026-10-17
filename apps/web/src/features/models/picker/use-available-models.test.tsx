// @vitest-environment happy-dom
import { AVAILABLE_MODELS_MAX, AVAILABLE_PROVIDERS_MAX } from "@pap/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { RpcError } from "../../../runtime/rpc.ts";
import { mount, settle } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { useAvailableModels, type AvailableState } from "./use-available-models.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const answer = (ids: readonly string[], extra: Record<string, unknown> = {}) => ({
  models: ids.map((id) => ({ provider: "mine", id, name: `Name ${id}`, reasoning: false })),
  providers: [{ id: "mine", name: "My server" }],
  origin: "signed-in",
  truncated: false,
  ...extra,
});

function setup() {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  const seen: { state: AvailableState } = { state: { status: "loading" } };
  function Probe({ cwd, enabled }: { readonly cwd: string | null; readonly enabled: boolean }) {
    seen.state = useAvailableModels(cwd, enabled);
    return null;
  }
  return { bed, seen, Probe };
}

const rowIds = (state: AvailableState) => (state.status === "ready" ? state.models.map((m) => m.id) : state);

describe("useAvailableModels", () => {
  it("does not call while the list is closed", async () => {
    const { bed, seen, Probe } = setup();
    await mount(<Probe cwd={null} enabled={false} />);
    await settle();
    expect(bed.called("models.available")).toEqual([]);
    expect(seen.state).toEqual({ status: "loading" });
  });

  it("calls models.available once on open with the folder, and with no cwd key for none", async () => {
    const { bed, seen, Probe } = setup();
    bed.handlers["models.available"] = () => answer(["a", "b"]);
    const page = await mount(<Probe cwd="/work/a" enabled={false} />);
    await page.rerender(<Probe cwd="/work/a" enabled />);
    await settle();
    expect(bed.called("models.available").map((call) => call.params)).toEqual([{ cwd: "/work/a" }]);
    expect(rowIds(seen.state)).toEqual(["a", "b"]);
    expect(seen.state).toMatchObject({
      status: "ready",
      origin: "signed-in",
      truncated: false,
      labels: new Map([["mine", "My server"]]),
    });
    await page.unmount();
    const none = setup();
    none.bed.handlers["models.available"] = () => answer(["z"]);
    await mount(<none.Probe cwd={null} enabled />);
    await settle();
    expect(none.bed.called("models.available").map((call) => call.params)).toEqual([{}]);
  });

  it("strips hidden characters from provider labels and model names, and clips them", async () => {
    const { bed, seen, Probe } = setup();
    bed.handlers["models.available"] = () => ({
      models: [{ provider: "mine", id: "m", name: `x${String.fromCodePoint(0x202e)}y`, reasoning: true }],
      providers: [{ id: "mine", name: `Mine${String.fromCodePoint(0x200b)}!` }],
      origin: "scope",
      truncated: true,
    });
    await mount(<Probe cwd={null} enabled />);
    await settle();
    expect(seen.state).toMatchObject({
      status: "ready",
      origin: "scope",
      truncated: true,
      models: [{ name: "xy", reasoning: true }],
      labels: new Map([["mine", "Mine!"]]),
    });
  });

  it("fails, then calls again on reload", async () => {
    const { bed, seen, Probe } = setup();
    let attempts = 0;
    let release: (value: unknown) => void = () => {};
    bed.handlers["models.available"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("helper_failed");
      return new Promise((resolve) => (release = resolve));
    };
    await mount(<Probe cwd={null} enabled />);
    await settle();
    expect(seen.state).toMatchObject({ status: "failed", stale: false });
    const failed = seen.state;
    if (failed.status !== "failed") throw new Error("expected failed");
    await act(async () => failed.reload());
    expect(seen.state).toEqual({ status: "loading" });
    expect(bed.called("models.available")).toHaveLength(2);
    await act(async () => release(answer(["after-retry"])));
    expect(rowIds(seen.state)).toEqual(["after-retry"]);
  });

  it("answers failed for a malformed answer", async () => {
    const { bed, seen, Probe } = setup();
    bed.handlers["models.available"] = () => ({ models: "nope" });
    await mount(<Probe cwd={null} enabled />);
    await settle();
    expect(seen.state).toMatchObject({ status: "failed", stale: false });
  });

  it("hook.caps: an answer past the contract's provider or model cap is failed, not shown", async () => {
    for (const over of [
      {
        providers: Array.from({ length: AVAILABLE_PROVIDERS_MAX + 1 }, (_, i) => ({
          id: `p${i}`,
          name: "P",
        })),
      },
      {
        models: Array.from({ length: AVAILABLE_MODELS_MAX + 1 }, (_, i) => ({
          provider: "mine",
          id: `m${i}`,
          name: "M",
          reasoning: false,
        })),
      },
      { origin: "session" },
      { models: [{ provider: "mine", id: "k", name: "K", reasoning: false, key: "sk-secret" }] },
    ]) {
      const { bed, seen, Probe } = setup();
      bed.handlers["models.available"] = () => answer(["a"], over);
      const page = await mount(<Probe cwd={null} enabled />);
      await settle();
      expect(seen.state).toMatchObject({ status: "failed", stale: false });
      await page.unmount();
    }
    const edge = setup();
    edge.bed.handlers["models.available"] = () =>
      answer(["a"], {
        providers: Array.from({ length: AVAILABLE_PROVIDERS_MAX }, (_, i) => ({ id: `p${i}`, name: "P" })),
      });
    await mount(<edge.Probe cwd={null} enabled />);
    await settle();
    expect(edge.seen.state.status).toBe("ready");
  });

  it("marks unknown_method and a stale chunk as stale (reload the page)", async () => {
    for (const failure of [
      new RpcError("unknown_method"),
      new Error("Failed to fetch dynamically imported module: /assets/x.js"),
    ]) {
      const { bed, seen, Probe } = setup();
      bed.handlers["models.available"] = () => {
        throw failure;
      };
      const page = await mount(<Probe cwd={null} enabled />);
      await settle();
      expect(seen.state).toMatchObject({ status: "failed", stale: true });
      await page.unmount();
    }
  });

  it("does not let the first open's late answer land on a second open", async () => {
    const { bed, seen, Probe } = setup();
    const releases: Array<(value: unknown) => void> = [];
    bed.handlers["models.available"] = () => new Promise((resolve) => releases.push(resolve));
    const page = await mount(<Probe cwd={null} enabled />);
    await page.rerender(<Probe cwd={null} enabled={false} />);
    await page.rerender(<Probe cwd={null} enabled />);
    expect(releases).toHaveLength(2);
    await act(async () => releases[0]?.(answer(["first"])));
    expect(seen.state).toEqual({ status: "loading" });
    await act(async () => releases[1]?.(answer(["second"])));
    expect(rowIds(seen.state)).toEqual(["second"]);
  });

  it("hook.cwd-change-is-loading: another folder is loading at once and never shows the previous rows", async () => {
    const { bed, seen, Probe } = setup();
    const waiting = new Map<string, (value: unknown) => void>();
    bed.handlers["models.available"] = (params) => {
      const cwd = (params as { cwd: string }).cwd;
      if (cwd === "/a") return answer(["only-a"]);
      return new Promise((resolve) => waiting.set(cwd, resolve));
    };
    const page = await mount(<Probe cwd="/a" enabled />);
    await settle();
    expect(rowIds(seen.state)).toEqual(["only-a"]);

    await page.rerender(<Probe cwd="/b" enabled />);
    expect(seen.state).toEqual({ status: "loading" });
    // B asked, then A is asked again while B is still unanswered: B's late answer must not land on A.
    await page.rerender(<Probe cwd="/a" enabled />);
    await settle();
    expect(rowIds(seen.state)).toEqual(["only-a"]);
    await page.rerender(<Probe cwd="/b" enabled />);
    expect(seen.state).toEqual({ status: "loading" });
    await act(async () => waiting.get("/b")?.(answer(["only-b"])));
    expect(rowIds(seen.state)).toEqual(["only-b"]);
  });

  it("hook.cwd-change late answer of the old folder is dropped", async () => {
    const { bed, seen, Probe } = setup();
    const waiting = new Map<string, (value: unknown) => void>();
    bed.handlers["models.available"] = (params) =>
      new Promise((resolve) => waiting.set((params as { cwd: string }).cwd, resolve));
    const page = await mount(<Probe cwd="/a" enabled />);
    await page.rerender(<Probe cwd="/b" enabled />);
    await act(async () => waiting.get("/a")?.(answer(["late-a"])));
    expect(seen.state).toEqual({ status: "loading" });
    await act(async () => waiting.get("/b")?.(answer(["b"])));
    expect(rowIds(seen.state)).toEqual(["b"]);
  });

  it("keeps no module-level state: a second tree starts loading and shows its own result", async () => {
    const first = setup();
    first.bed.handlers["models.available"] = () => answer(["first-tree"]);
    const one = await mount(<first.Probe cwd={null} enabled />);
    await settle();
    expect(rowIds(first.seen.state)).toEqual(["first-tree"]);
    await one.unmount();

    const second = setup();
    let release: (value: unknown) => void = () => {};
    second.bed.handlers["models.available"] = () => new Promise((resolve) => (release = resolve));
    await mount(<second.Probe cwd={null} enabled />);
    expect(second.seen.state).toEqual({ status: "loading" });
    await act(async () => release(answer(["second-tree"])));
    expect(rowIds(second.seen.state)).toEqual(["second-tree"]);
  });
});
