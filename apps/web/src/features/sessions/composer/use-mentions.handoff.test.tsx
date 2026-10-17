// @vitest-environment happy-dom
import { TextField } from "@pap/ui";
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { useHandOffPorts } from "../../../stores/composer-hand-off.ts";
import { field, mount, press, settle, typeInto } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import "./register-files-catalog.ts";
import { useComposerFieldProps } from "./menus.ts";
import { MentionMenu } from "./MentionMenu.tsx";
import { useMentions } from "./use-mentions.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const none = { onPaste: () => {}, onDrop: () => {}, onDragOver: () => {} };
const timers = { set: (fn: () => void) => (queueMicrotask(fn), 1), clear: () => {} };

function Probe({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const mentions = useMentions({ sessionId, text, setText, root: "/p", folder: "/p", timers });
  return (
    <>
      <TextField
        label="Message"
        multiline
        value={text}
        onChange={setText}
        {...useComposerFieldProps([mentions], none)}
      />
      <MentionMenu menu={mentions.menu} />
    </>
  );
}
const options = (container: ParentNode) =>
  [...container.querySelectorAll('[role="option"]')].map((node) => node.textContent);

beforeEach(() => {
  const bed = fakeRuntime();
  bed.handlers["files.search"] = () => ({ paths: ["scout-notes.md"], truncated: false });
  current.runtime = bed.runtime;
  useHandOffPorts.setState({ ports: {} });
});
const withPort = (names: string[]) =>
  act(() => useHandOffPorts.getState().register("s1", { names, handOff: () => false }));

describe("the @ menu in an agent thread (M11R123)", () => {
  it("lists agent names first while the caret is in the first word, files after", async () => {
    withPort(["Scout", "Sage", "Atlas2"]);
    const page = await mount(<Probe sessionId="s1" />);
    await typeInto(field(page.container, "Message"), "@S");
    await settle();
    expect(options(page.container)).toEqual(["@Scout", "@Sage", "scout-notes.md"]);
  });

  it("lists every other agent on a bare @", async () => {
    withPort(["Scout", "Sage"]);
    const page = await mount(<Probe sessionId="s1" />);
    await typeInto(field(page.container, "Message"), "@");
    expect(options(page.container)).toEqual(["@Scout", "@Sage"]);
  });

  it("matches names by prefix, any case", async () => {
    withPort(["Scout", "Sage"]);
    const page = await mount(<Probe sessionId="s1" />);
    await typeInto(field(page.container, "Message"), "@sc");
    await settle();
    expect(options(page.container)).toEqual(["@Scout", "scout-notes.md"]);
  });

  it("writes `@Name ` when a name is picked", async () => {
    withPort(["Scout"]);
    const page = await mount(<Probe sessionId="s1" />);
    const area = field(page.container, "Message");
    await typeInto(area, "@Sc");
    await settle();
    await press(area, { key: "Enter" });
    expect(area.value).toBe("@Scout ");
  });

  it("offers no agent name after the first word: files only", async () => {
    withPort(["Scout"]);
    const page = await mount(<Probe sessionId="s1" />);
    await typeInto(field(page.container, "Message"), "look at @sc");
    await settle();
    expect(options(page.container)).toEqual(["scout-notes.md"]);
  });

  it("offers no agent name in a session without a port", async () => {
    const page = await mount(<Probe sessionId="s2" />);
    await typeInto(field(page.container, "Message"), "@sc");
    await settle();
    expect(options(page.container)).toEqual(["scout-notes.md"]);
  });
});
