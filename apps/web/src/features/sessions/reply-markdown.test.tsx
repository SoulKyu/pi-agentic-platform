// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReplyPorts, type ReplyPort } from "../../stores/reply-ports.ts";
import { mount } from "../../testing/dom.ts";
import { useReplyMarkdown } from "./reply-markdown.ts";

type Tools = ReturnType<typeof useReplyMarkdown>;
const seen: Tools[] = [];
function Probe({ sessionId }: { readonly sessionId: string }) {
  seen.push(useReplyMarkdown(sessionId, true));
  return null;
}

const openFile = vi.fn<ReplyPort["openFile"]>();
const port = (): ReplyPort => ({
  scope: { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null },
  openFile,
});

beforeEach(() => {
  seen.length = 0;
  openFile.mockClear();
  useReplyPorts.getState().reset();
});

describe("useReplyMarkdown", () => {
  it("no port: no pathLinks, and the load error and copy labels stay", async () => {
    await mount(<Probe sessionId="s1" />);
    const tools = seen.at(-1);
    expect(tools?.pathLinks).toBeUndefined();
    expect(tools?.onLoadError).toBeTypeOf("function");
    expect(tools?.copyLabels).toEqual({ copy: "Copy code", copied: "Copied" });
  });

  it("with a port: find uses its scope and open calls openFile", async () => {
    useReplyPorts.getState().register("s1", port());
    await mount(<Probe sessionId="s1" />);
    const links = seen.at(-1)?.pathLinks;
    const [span] = links?.find("see src/a.ts:9", false) ?? [];
    expect(span).toMatchObject({ path: "/w/p/src/a.ts", line: 9, text: "src/a.ts:9" });
    expect(links?.find("see /etc/passwd", false)).toEqual([]);
    expect(links?.label(span as NonNullable<typeof span>)).toBe("Open src/a.ts:9 in Files");
    links?.open(span as NonNullable<typeof span>);
    expect(openFile).toHaveBeenCalledWith("/w/p/src/a.ts", 9);
  });

  it("richReplies: localized labels always, image and openFile only with a port", async () => {
    await mount(<Probe sessionId="s1" />);
    const without = seen.at(-1)?.richReplies;
    expect(without?.image).toBeUndefined();
    expect(without?.openFile).toBeUndefined();
    expect(without?.labels.image("a cat")).toBe("[image: a cat]");
    expect(without?.labels.diagram).toBe("Diagram");
    expect(without?.labels.openFile("/w/p/a.csv")).toBe("Open /w/p/a.csv in Files");
    useReplyPorts.getState().register("s1", port());
    await mount(<Probe sessionId="s1" />);
    const rich = seen.at(-1)?.richReplies;
    expect(await rich?.image?.("https://x/a.png")).toEqual({ kind: "text" });
    expect(await rich?.image?.("data.csv")).toEqual({ kind: "file", path: "/w/p/data.csv" });
    rich?.openFile?.("/w/p/data.csv");
    expect(openFile).toHaveBeenCalledWith("/w/p/data.csv", null);
  });

  it("richReplies is the same object when only `finished` changes, and reports a load failure", async () => {
    useReplyPorts.getState().register("s1", port());
    const finishedSeen: Array<Tools["richReplies"]> = [];
    function Flip({ finished }: { readonly finished: boolean }) {
      finishedSeen.push(useReplyMarkdown("s1", finished).richReplies);
      return null;
    }
    const page = await mount(<Flip finished={false} />);
    await page.rerender(<Flip finished />);
    expect(finishedSeen.length).toBeGreaterThan(1);
    expect(finishedSeen.at(-1)).toBe(finishedSeen[0]);
    expect(finishedSeen[0]?.onLoadError).toBeTypeOf("function");
  });

  it("another session's port is not used", async () => {
    useReplyPorts.getState().register("s2", port());
    await mount(<Probe sessionId="s1" />);
    expect(seen.at(-1)?.pathLinks).toBeUndefined();
  });

  it("the object is the same across renders while the port is", async () => {
    useReplyPorts.getState().register("s1", port());
    const page = await mount(<Probe sessionId="s1" />);
    await page.rerender(<Probe sessionId="s1" />);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(seen.at(-2));
    const before = seen.at(-1);
    await act(async () => {
      useReplyPorts.getState().register("s1", port());
    });
    expect(seen.at(-1)).not.toBe(before);
  });
});
