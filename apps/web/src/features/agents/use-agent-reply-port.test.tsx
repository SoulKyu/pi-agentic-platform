// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useReplyPorts } from "../../stores/reply-ports.ts";
import { mount } from "../../testing/dom.ts";
import { useAgentReplyPort } from "./use-agent-reply-port.ts";

const openFilesTab = vi.fn();
function Host({ sessionId }: { readonly sessionId: string | null }) {
  useAgentReplyPort("a1", sessionId, openFilesTab);
  return null;
}

beforeEach(() => {
  openFilesTab.mockClear();
  useReplyPorts.getState().reset();
  useFilesTarget.getState().reset();
});

describe("useAgentReplyPort", () => {
  it("an agent thread's port scopes /agent/{home,inbox,knowledge} and opens the Files tab with the target on /agents/<id>", async () => {
    await mount(<Host sessionId="s1" />);
    const port = useReplyPorts.getState().ports["s1"];
    expect(port?.scope).toEqual({
      base: "/agent/home",
      roots: ["/agent/home", "/agent/inbox", "/agent/knowledge"],
      filesRoot: "/agents/a1",
      agentId: "a1",
    });
    port?.openFile("/agents/a1/home/notes.md", 4);
    expect(useFilesTarget.getState().targets["/agents/a1"]).toMatchObject({
      path: "/agents/a1/home/notes.md",
      line: 4,
    });
    expect(openFilesTab).toHaveBeenCalledOnce();
  });

  it("no port before the thread's session id is known", async () => {
    const page = await mount(<Host sessionId={null} />);
    expect(useReplyPorts.getState().ports).toEqual({});
    await page.rerender(<Host sessionId="s1" />);
    expect(Object.keys(useReplyPorts.getState().ports)).toEqual(["s1"]);
    await page.unmount();
    expect(useReplyPorts.getState().ports).toEqual({});
  });
});
