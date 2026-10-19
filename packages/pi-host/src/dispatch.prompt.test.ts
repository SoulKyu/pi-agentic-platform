import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import { readPromptImages } from "./prompt-images.ts";
import type { UiBridge } from "./ui-bridge.ts";

vi.mock("./prompt-images.ts", () => ({ readPromptImages: vi.fn() }));
const read = vi.mocked(readPromptImages);

const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function bed() {
  const sent: Array<Record<string, unknown>> = [];
  const prompt = vi.fn(async (_text: string, options?: { preflightResult?: (d: string) => void }) => {
    options?.preflightResult?.("started");
  });
  const abort = vi.fn(async () => {});
  const dispatch = createDispatch({
    papHome: "/pap",
    session: { prompt, abort } as unknown as AgentSession,
    ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
    ui: {} as UiBridge,
    approvals: {} as Approvals,
    leafMayHaveMoved: () => {},
    setRules: () => {},
    applyTaint: () => {},
  });
  return { sent, prompt, abort, dispatch };
}
const withImage = { path: "/pap/attachments/pending/x", mimeType: "image/png" as const };

beforeEach(() => read.mockReset());

describe("dispatch prompt FIFO (M8R107, RT-07)", () => {
  it("hands an image prompt to Pi before the text prompt that followed it", async () => {
    const { prompt, dispatch } = bed();
    let open!: () => void;
    read.mockReturnValue(new Promise((resolve) => (open = () => resolve([image]))));
    dispatch({ type: "prompt", id: "p1", message: "a", images: [withImage] });
    dispatch({ type: "prompt", id: "p2", message: "b" });
    await settle();
    expect(prompt).not.toHaveBeenCalled();
    open();
    await settle();
    expect(prompt.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(prompt.mock.calls[0]?.[1]).toMatchObject({ images: [image] });
    expect(prompt.mock.calls[1]?.[1]).not.toHaveProperty("images");
    expect(read).toHaveBeenCalledWith("/pap", [withImage]);
  });

  it("answers pap:aborted to an image prompt a Stop overtook, never hands it to Pi, and still aborts Pi", async () => {
    const { sent, prompt, abort, dispatch } = bed();
    let open!: () => void;
    read.mockReturnValue(new Promise((resolve) => (open = () => resolve([image]))));
    dispatch({ type: "prompt", id: "p1", message: "a", images: [withImage] });
    dispatch({ type: "abort", id: "s1" });
    open();
    await settle();
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({
      type: "response",
      id: "p1",
      command: "prompt",
      success: false,
      error: "pap:aborted",
    });
  });

  it("answers pap:image_unreadable when an image is refused, and never hands the prompt to Pi", async () => {
    const { sent, prompt, dispatch } = bed();
    read.mockResolvedValue(null);
    dispatch({ type: "prompt", id: "p1", message: "a", images: [withImage] });
    await settle();
    expect(prompt).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: "response", id: "p1", command: "prompt", success: false, error: "pap:image_unreadable" },
    ]);
  });

  it("starts a text prompt synchronously when nothing is ahead", () => {
    const { prompt, dispatch } = bed();
    dispatch({ type: "prompt", id: "p1", message: "a" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch prompt FIFO: Pi's own steps (M8R107)", () => {
  it("keeps a text prompt behind an image prompt until Pi has answered the image prompt", async () => {
    const answers: Array<(disposition: string) => void> = [];
    const prompt = vi.fn(
      (_text: string, options?: { preflightResult?: (d: string) => void }) =>
        new Promise<void>((done) =>
          answers.push((disposition) => {
            options?.preflightResult?.(disposition);
            done();
          }),
        ),
    );
    const dispatch = createDispatch({
      papHome: "/pap",
      session: { prompt, abort: async () => {} } as unknown as AgentSession,
      ipc: { send: () => {} } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
      applyTaint: () => {},
    });
    read.mockResolvedValue([image]);
    dispatch({ type: "prompt", id: "p1", message: "a", images: [withImage] });
    dispatch({ type: "prompt", id: "p2", message: "b" });
    await settle();
    expect(prompt.mock.calls.map((call) => call[0])).toEqual(["a"]);
    answers[0]?.("started");
    await settle();
    expect(prompt.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });
});

describe("dispatch file_put (R33)", () => {
  const put = {
    type: "file_put" as const,
    id: "0123456789abcdef0123456789abcdef",
    name: "a.png",
    offset: 0,
    data: "",
    last: true,
  };
  const make = (inbox?: { put: (chunk: unknown) => unknown }) => {
    const sent: Array<Record<string, unknown>> = [];
    const dispatch = createDispatch({
      papHome: "/pap",
      session: {} as unknown as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
      applyTaint: () => {},
      ...(inbox ? { inbox: inbox as never } : {}),
    });
    return { sent, dispatch };
  };

  it("sends the inbox's answer, and nothing while a transfer is open", () => {
    const answers = [null, { type: "file_put_result", id: put.id, ok: true }];
    const { sent, dispatch } = make({ put: () => answers.shift() });
    dispatch(put);
    expect(sent).toEqual([]);
    dispatch(put);
    expect(sent).toEqual([{ type: "file_put_result", id: put.id, ok: true }]);
  });

  it("ignores a file_put outside a VM", () => {
    const { sent, dispatch } = make();
    dispatch(put);
    expect(sent).toEqual([]);
  });

  it("reads a VM prompt's images from the inbox", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const prompt = vi.fn(async (_t: string, o?: { preflightResult?: (d: string) => void }) =>
      o?.preflightResult?.("s"),
    );
    const dispatch = createDispatch({
      papHome: "/pap",
      session: { prompt } as unknown as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
      applyTaint: () => {},
      inboxDir: "/agent/inbox",
    });
    read.mockResolvedValue([image]);
    dispatch({ type: "prompt", id: "p1", message: "a", images: [withImage] });
    await settle();
    expect(read).toHaveBeenCalledWith("/pap", [withImage], "/agent/inbox");
  });
});
