// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReplyPorts, type ReplyPort } from "../../stores/reply-ports.ts";
import { useShellAnswers } from "../../stores/shell-answers.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, mount, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { MessageRow } from "./MessageRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => Promise.resolve() }));

let page: Mounted | null = null;
const toTerminal = vi.fn<NonNullable<ReplyPort["toTerminal"]>>();
const portOf = (withTerminal: boolean): ReplyPort => ({
  scope: { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null },
  openFile: () => {},
  ...(withTerminal ? { toTerminal } : {}),
});
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  toTerminal.mockReset();
  toTerminal.mockResolvedValue("typed");
  useReplyPorts.getState().reset();
  useShellAnswers.getState().reset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const TEXT = "Run it:\n\n```bash\ntouch a\n```\n\n```python\nprint(1)\n```\n";
const agent = (text: string) => ({
  kind: "message" as const,
  key: "m",
  author: "agent" as const,
  text,
  thinking: "",
  entryId: null,
});
const partial = (text: string) => ({ kind: "partial" as const, key: "p", text, thinking: "" });
const block = () => document.querySelector("[data-shell-block]");
const toTerminalButton = () =>
  [...document.querySelectorAll("[data-shell-block] button")].find((node) =>
    /to terminal/i.test(node.textContent ?? ""),
  );

describe("shell blocks in a reply", () => {
  it("a finished reply's bash block has To terminal, and a click types through the port", async () => {
    useReplyPorts.getState().register("s1", portOf(true));
    page = await mount(<MessageRow sessionId="s1" item={agent(TEXT)} />);
    await vi.waitFor(() => expect(block()).not.toBeNull(), { timeout: 2_000 });
    expect(document.querySelectorAll("[data-shell-block]")).toHaveLength(1);
    await click(toTerminalButton() as Element);
    expect(toTerminal).toHaveBeenCalledExactlyOnceWith("touch a");
    await vi.waitFor(
      () => expect(block()?.querySelector("[role='status']")?.textContent).toMatch(/press enter/i),
      {
        timeout: 2_000,
      },
    );
  });

  it("a refusal shows its copy as an alert", async () => {
    toTerminal.mockResolvedValue("multiline");
    useReplyPorts.getState().register("s1", portOf(true));
    page = await mount(<MessageRow sessionId="s1" item={agent(TEXT)} />);
    await vi.waitFor(() => expect(block()).not.toBeNull(), { timeout: 2_000 });
    await click(toTerminalButton() as Element);
    await vi.waitFor(
      () => expect(block()?.querySelector("[role='alert']")?.textContent).toMatch(/several lines/i),
      {
        timeout: 2_000,
      },
    );
  });

  it("the streaming reply's has none", async () => {
    useReplyPorts.getState().register("s1", portOf(true));
    page = await mount(<MessageRow sessionId="s1" item={partial(TEXT)} />);
    await vi.waitFor(() => expect(document.querySelector("[data-slot='code-block']")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(block()).toBeNull();
  });

  it("an agent thread's has none", async () => {
    useReplyPorts.getState().register("s1", portOf(false));
    page = await mount(<MessageRow sessionId="s1" item={agent(TEXT)} />);
    await vi.waitFor(() => expect(document.querySelector("[data-slot='code-block']")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(block()).toBeNull();
  });

  it("the answer survives the chat mounting again (a split, a phone's pane switch)", async () => {
    toTerminal.mockResolvedValue("timeout");
    useReplyPorts.getState().register("s1", portOf(true));
    page = await mount(<MessageRow sessionId="s1" item={agent(TEXT)} />);
    await vi.waitFor(() => expect(block()).not.toBeNull(), { timeout: 2_000 });
    await click(toTerminalButton() as Element);
    await vi.waitFor(() => expect(block()?.querySelector("[role='alert']")?.textContent).toMatch(/10 s/), {
      timeout: 2_000,
    });
    await page.unmount();
    page = await mount(<MessageRow sessionId="s1" item={agent(TEXT)} />);
    await vi.waitFor(() => expect(block()?.querySelector("[role='alert']")?.textContent).toMatch(/10 s/), {
      timeout: 2_000,
    });
  });

  it("an empty and a too long block: no button, and the refusal in words", async () => {
    useReplyPorts.getState().register("s1", portOf(true));
    const long = `\`\`\`bash\n${"a".repeat(16 * 1024 + 1)}\n\`\`\``;
    page = await mount(<MessageRow sessionId="s1" item={agent(`${long}\n\n\`\`\`bash\n\n\`\`\``)} />);
    await vi.waitFor(() => expect(block()).not.toBeNull(), { timeout: 2_000 });
    expect(document.querySelectorAll("[data-shell-block]")).toHaveLength(1);
    await click(toTerminalButton() as Element);
    await vi.waitFor(
      () => expect(block()?.querySelector("[role='alert']")?.textContent).toMatch(/too long/),
      {
        timeout: 2_000,
      },
    );
    expect(toTerminal).not.toHaveBeenCalled();
  });
});
