// @vitest-environment happy-dom
import { TextField } from "@pap/ui";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { act } from "react";
import { overlayIsOpen } from "../../../testing/context.ts";
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

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    set: (fn: () => void, ms: number) => {
      pending.set(++next, { fn, ms });
      return next;
    },
    clear: (id: number) => void pending.delete(id),
    pending,
    async fire() {
      const due = [...pending.values()];
      pending.clear();
      await act(async () => {
        for (const timer of due) timer.fn();
      });
    },
  };
}

const none = { onPaste: () => {}, onDrop: () => {}, onDragOver: () => {} };
let latest: ReturnType<typeof useMentions> | null = null;

function Probe({ timers, initial = "" }: { timers: ReturnType<typeof fakeTimers>; initial?: string }) {
  const [text, setText] = useState(initial);
  const mentions = useMentions({ sessionId: "s1", text, setText, root: "/p", folder: "/p/app", timers });
  useEffect(() => {
    latest = mentions;
  });
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

function setup() {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  return { bed, timers: fakeTimers() };
}
const options = (container: ParentNode) =>
  [...container.querySelectorAll('[role="option"]')].map((node) => node.textContent);

describe("useMentions", () => {
  it("searches once, 150 ms after typing stops, in the project root", async () => {
    const { bed, timers } = setup();
    bed.handlers["files.search"] = () => ({ paths: ["lib/x.ts"], truncated: false });
    const page = await mount(<Probe timers={timers} />);
    await typeInto(field(page.container, "Message"), "see @s");
    await typeInto(field(page.container, "Message"), "see @sr");
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([150]);
    expect(bed.called("files.search")).toEqual([]);
    await timers.fire();
    await settle();
    expect(bed.called("files.search").map((call) => call.params)).toEqual([
      { root: "/p", query: "sr", limit: 8 },
    ]);
    expect(options(page.container)).toEqual(["../lib/x.ts"]);
  });

  it("drops an answer to an older query that arrives last", async () => {
    const { bed, timers } = setup();
    const answers: Array<(value: unknown) => void> = [];
    bed.handlers["files.search"] = () => new Promise((resolve) => answers.push(resolve));
    const page = await mount(<Probe timers={timers} />);
    await typeInto(field(page.container, "Message"), "@a");
    await timers.fire();
    await typeInto(field(page.container, "Message"), "@ab");
    await timers.fire();
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]?.({ paths: ["new.ts"], truncated: false }));
    await act(async () => answers[0]?.({ paths: ["old.ts"], truncated: false }));
    expect(options(page.container)).toEqual(["../new.ts"]);
  });

  it("closes on Escape (never stopping the run) and shows as an open overlay while it is open", async () => {
    const { bed, timers } = setup();
    bed.handlers["files.search"] = () => ({ paths: ["lib/x.ts"], truncated: false });
    const page = await mount(<Probe timers={timers} />);
    const area = field(page.container, "Message");
    await typeInto(area, "@l");
    await timers.fire();
    await settle();
    expect(overlayIsOpen()).toBe(true);
    expect(latest?.open).toBe(true);
    const escape = await press(area, { key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(options(page.container)).toEqual([]);
    expect(overlayIsOpen()).toBe(false);
    expect(latest?.open).toBe(false);
  });

  it("inserts the active result on Enter or Tab, relative to the session folder, and moves with the arrows", async () => {
    const { bed, timers } = setup();
    bed.handlers["files.search"] = () => ({ paths: ["lib/x.ts", "app/y z.ts"], truncated: false });
    const page = await mount(<Probe timers={timers} />);
    const area = field(page.container, "Message");
    await typeInto(area, "see @l");
    await timers.fire();
    await settle();
    expect(area.getAttribute("role")).toBe("combobox");
    expect(area.getAttribute("aria-expanded")).toBe("true");
    const listbox = page.container.querySelector('[role="listbox"]');
    expect(area.getAttribute("aria-controls")).toBe(listbox?.id);
    const down = await press(area, { key: "ArrowDown" });
    expect(down.defaultPrevented).toBe(true);
    expect(area.getAttribute("aria-activedescendant")).toBe(
      page.container.querySelectorAll('[role="option"]')[1]?.id,
    );
    const enter = await press(area, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(area.value).toBe('see @"y z.ts" ');
    expect(options(page.container)).toEqual([]);
    expect(area.getAttribute("aria-expanded")).toBeNull();
  });

  it("inserts on Tab as well, and does nothing during an input-method composition", async () => {
    const { bed, timers } = setup();
    bed.handlers["files.search"] = () => ({ paths: ["lib/x.ts"], truncated: false });
    const page = await mount(<Probe timers={timers} />);
    const area = field(page.container, "Message");
    await typeInto(area, "@l");
    await timers.fire();
    await settle();
    const composing = await press(area, { key: "Enter", isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(area.value).toBe("@l");
    await press(area, { key: "Tab" });
    expect(area.value).toBe("@../lib/x.ts ");
  });

  it("inserts a dropped explorer path at the caret", async () => {
    const { timers } = setup();
    const page = await mount(<Probe timers={timers} initial="look at" />);
    await act(async () => latest?.dropPath?.("/p/lib/x.ts"));
    expect(field(page.container, "Message").value).toBe("look at @../lib/x.ts ");
  });

  it("refuses a dropped path with a bidi, zero-width or line-break character (MC38 m4)", async () => {
    const { timers } = setup();
    const page = await mount(<Probe timers={timers} initial="look at" />);
    for (const name of ["x\u202Ey.ts", "x\u200By.ts", "x\ny.ts"]) {
      await act(async () => latest?.dropPath?.(`/p/lib/${name}`));
    }
    expect(field(page.container, "Message").value).toBe("look at");
  });

  it("returns the ComposerMenu shape plus its menu", async () => {
    const { timers } = setup();
    await mount(<Probe timers={timers} />);
    expect(Object.keys(latest ?? {}).sort()).toEqual(
      ["close", "combobox", "dropPath", "fieldRef", "menu", "onKeyDown", "open"].sort(),
    );
    expect(latest?.open).toBe(false);
    expect(latest?.combobox).toBeNull();
    expect(latest?.menu).toBeNull();
  });

  it("offers nothing and says it once in the console when the search fails", async () => {
    const { bed, timers } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bed.handlers["files.search"] = () => {
      throw new Error("down");
    };
    const page = await mount(<Probe timers={timers} />);
    await typeInto(field(page.container, "Message"), "@q");
    await timers.fire();
    await settle();
    expect(options(page.container)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("pap: mention_search_failed");
    warn.mockRestore();
  });
});
