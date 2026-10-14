// @vitest-environment happy-dom
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../../testing/dom.ts";
import { useComposerFieldProps, type ComposerMenu } from "./menus.ts";

const key = (init: object = {}) =>
  ({
    key: "Enter",
    nativeEvent: { isComposing: false },
    ...init,
  }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

function fake(open: boolean, id: string): ComposerMenu & { keys: string[]; closed: number } {
  const menu = {
    open,
    keys: [] as string[],
    closed: 0,
    close() {
      menu.closed++;
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      menu.keys.push(event.key);
    },
    combobox: open ? { expanded: true, controls: `list-${id}`, activeDescendant: null } : null,
  };
  return menu;
}

const attachments = {
  onPaste: vi.fn<(event: ClipboardEvent<HTMLTextAreaElement>) => void>(),
  onDrop: vi.fn<(event: DragEvent<HTMLTextAreaElement>) => void>(),
  onDragOver: vi.fn<(event: DragEvent<HTMLTextAreaElement>) => void>(),
};

type FieldProps = ReturnType<typeof useComposerFieldProps>;

/** Renders a component that calls `useComposerFieldProps` (it holds an effect) and returns what it gave. */
async function render(
  menus: readonly ComposerMenu[],
  handlers: typeof attachments = attachments,
): Promise<FieldProps> {
  let latest: FieldProps | null = null;
  function Probe() {
    const given = useComposerFieldProps(menus, handlers);
    useEffect(() => {
      latest = given;
    });
    return null;
  }
  await mount(<Probe />);
  if (!latest) throw new Error("not rendered");
  return latest;
}

describe("useComposerFieldProps", () => {
  it("gives the key to the first open menu only, and returns its combobox", async () => {
    const a = fake(false, "a");
    const b = fake(true, "b");
    const c = fake(true, "c");
    const props = await render([a, b, c], attachments);
    props.onKeyDown?.(key());
    expect([a.keys, b.keys, c.keys]).toEqual([[], ["Enter"], []]);
    expect(props.combobox).toBe(b.combobox);
  });

  it("gives the key to nobody when no menu is open, and has no combobox", async () => {
    const a = fake(false, "a");
    const props = await render([a], attachments);
    props.onKeyDown?.(key());
    expect(a.keys).toEqual([]);
    expect(props.combobox).toBeNull();
  });

  it("closes every open menu after the first, once", async () => {
    const a = fake(true, "a");
    const b = fake(true, "b");
    const c = fake(false, "c");
    await render([a, b, c]);
    expect([a.closed, b.closed, c.closed]).toEqual([0, 1, 0]);
  });

  it("never lets a key reach a menu during an IME composition", async () => {
    const a = fake(true, "a");
    const props = await render([a], attachments);
    props.onKeyDown?.(key({ nativeEvent: { isComposing: true } }));
    props.onKeyDown?.(key({ nativeEvent: { isComposing: false, keyCode: 229 } }));
    expect(a.keys).toEqual([]);
  });

  it("passes the attachments' paste and dragover through unchanged, and a drop that is not a path", async () => {
    const props = await render([fake(false, "a")], attachments);
    expect(props.onPaste).toBe(attachments.onPaste);
    expect(props.onDragOver).toBe(attachments.onDragOver);
    const drop = { dataTransfer: { getData: () => "" } } as unknown as DragEvent<HTMLTextAreaElement>;
    props.onDrop?.(drop);
    expect(attachments.onDrop).toHaveBeenCalledWith(drop);
  });

  it("hands a dropped explorer path to the first menu that takes paths, and not to the attachments", async () => {
    attachments.onDrop.mockClear();
    const taken: string[] = [];
    const menu = { ...fake(false, "a"), dropPath: (path: string) => void taken.push(path) };
    const props = await render([menu], attachments);
    const preventDefault = vi.fn();
    props.onDrop?.({
      preventDefault,
      dataTransfer: { getData: (type: string) => (type === "application/x-pap-path" ? "/p/a.ts" : "") },
    } as unknown as DragEvent<HTMLTextAreaElement>);
    expect(taken).toEqual(["/p/a.ts"]);
    expect(preventDefault).toHaveBeenCalled();
    expect(attachments.onDrop).not.toHaveBeenCalled();
  });

  it("exposes the field ref of the first menu that owns one", async () => {
    const ref = { current: null };
    const props = await render([fake(false, "a"), { ...fake(false, "b"), fieldRef: ref }], attachments);
    expect(props.inputRef).toBe(ref);
  });
});
