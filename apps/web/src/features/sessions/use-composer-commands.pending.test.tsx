// @vitest-environment happy-dom
import { TextField } from "@pap/ui";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { field, mount, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useComposerFieldProps } from "./composer/menus.ts";
import { useComposerCommands } from "./use-composer-commands.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
// The listbox chunk never arrives: the rows are not on the page.
vi.mock("./CommandMenu.tsx", () => new Promise(() => {}));

const none = { onPaste: () => {}, onDrop: () => {}, onDragOver: () => {} };
let latest: ReturnType<typeof useComposerCommands> | null = null;

function Probe() {
  const [text, setText] = useState("");
  const commands = useComposerCommands({ sessionId: "s1", text, setText });
  useEffect(() => {
    latest = commands;
  });
  return (
    <>
      {commands.menu}
      <TextField
        label="Message"
        multiline
        value={text}
        onChange={setText}
        {...useComposerFieldProps([commands], none)}
      />
    </>
  );
}

describe("useComposerCommands before the listbox chunk has rendered", () => {
  it("points the field at no row that is not on the page yet", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["sessions.commands"] = () => ({
      commands: [{ name: "review", description: null, source: "prompt", builtinMcp: false }],
      truncated: false,
    });
    const page = await mount(<Probe />);
    await typeInto(field(page.container, "Message"), "/re");
    await settle();
    expect(latest?.open).toBe(true);
    expect(latest?.combobox?.activeDescendant).toBeNull();
    expect(page.container.querySelector('[role="option"]')).toBeNull();
  });
});
