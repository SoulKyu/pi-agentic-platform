// @vitest-environment happy-dom
import type { SearchHit } from "@pap/contracts";
import { act, useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { mount } from "../../../testing/dom.ts";
import { useTranscriptSearch } from "./transcript-search.ts";

const call = vi.hoisted(() => vi.fn());
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call } }),
}));

type Result = ReturnType<typeof useTranscriptSearch>;
const seen: Result[] = [];
const latest = () => seen.at(-1);
function Probe({ query }: { query: string }) {
  const result = useTranscriptSearch(query);
  useEffect(() => {
    seen.push(result);
  });
  return null;
}
const hit = (entryId: string) => ({ sessionId: `s-${entryId}`, entryId }) as SearchHit;
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  seen.length = 0;
  vi.useFakeTimers();
  call.mockReset();
});
afterEach(() => vi.useRealTimers());

it("does not ask below 3 characters nor for an actions-only query, and stays idle", async () => {
  const page = await mount(<Probe query="a" />);
  await page.rerender(<Probe query="ab " />);
  await page.rerender(<Probe query="> settings" />);
  await wait(1000);
  expect(call).not.toHaveBeenCalled();
  expect(latest()).toEqual({ status: "idle", hits: [] });
});

it("asks once, 150 ms after the last change, and says it is loading meanwhile", async () => {
  call.mockResolvedValue({ hits: [hit("e1")] });
  const page = await mount(<Probe query="kub" />);
  await wait(100);
  await page.rerender(<Probe query="kube" />);
  await wait(100);
  await page.rerender(<Probe query="kubex" />);
  await wait(100);
  await page.rerender(<Probe query=" kube " />);
  await wait(149);
  expect(call).not.toHaveBeenCalled();
  expect(latest()?.status).toBe("loading");
  await wait(1);
  expect(call.mock.calls).toEqual([["search.query", { q: "kube", limit: 20 }]]);
  expect(latest()).toEqual({ status: "done", hits: [hit("e1")] });
});

it("drops an older answer when a newer query was asked", async () => {
  let answerOld: (value: unknown) => void = () => {};
  call.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)));
  call.mockResolvedValueOnce({ hits: [hit("new")] });
  const page = await mount(<Probe query="old" />);
  await wait(150);
  await page.rerender(<Probe query="newer" />);
  await wait(150);
  expect(latest()).toEqual({ status: "done", hits: [hit("new")] });
  await act(async () => answerOld({ hits: [hit("old")] }));
  expect(latest()).toEqual({ status: "done", hits: [hit("new")] });
});

it("drops a pending answer once the query went below the minimum", async () => {
  let answer: (value: unknown) => void = () => {};
  call.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const page = await mount(<Probe query="kube" />);
  await wait(150);
  await page.rerender(<Probe query="ku" />);
  await act(async () => answer({ hits: [hit("old")] }));
  expect(latest()).toEqual({ status: "idle", hits: [] });
});

it("reports the code of a failed search, never silently", async () => {
  call.mockRejectedValue(new RpcError("timeout"));
  await mount(<Probe query="kube" />);
  await wait(150);
  expect(latest()).toEqual({ status: "error", hits: [], code: "timeout" });
});

it("maps a failure that is not an RpcError to internal", async () => {
  call.mockRejectedValue(new TypeError("boom"));
  await mount(<Probe query="kube" />);
  await wait(150);
  expect(latest()).toEqual({ status: "error", hits: [], code: "internal" });
});

it("asks nothing when unmounted inside the debounce", async () => {
  const page = await mount(<Probe query="kube" />);
  await page.unmount();
  await wait(500);
  expect(call).not.toHaveBeenCalled();
});
