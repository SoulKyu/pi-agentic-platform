// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerInsert } from "../../../stores/composer-insert.ts";
import { mount } from "../../../testing/dom.ts";
import { useInsertInto } from "./use-insert.ts";

function Harness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useInsertInto("s1", field, text, setText);
  return <textarea ref={field} value={text} onChange={(event) => setText(event.target.value)} />;
}

beforeEach(() => useComposerInsert.getState().reset());

describe("useInsertInto", () => {
  it("the inserted text lands at the caret and the caret moves after it", async () => {
    const page = await mount(<Harness initial="hello world" />);
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      area.focus();
      area.setSelectionRange(5, 5);
    });
    await act(async () => {
      useComposerInsert.getState().push("s1", "> q\n\n");
    });
    expect(area.value).toBe("hello\n> q\n\n world");
    expect(area.selectionStart).toBe(11);
    expect(document.activeElement).toBe(area);
    expect(useComposerInsert.getState().items).toEqual({});
  });

  it("goes to the end when the field never had focus", async () => {
    const page = await mount(<Harness initial="hello" />);
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      useComposerInsert.getState().push("s1", "> q\n\n");
    });
    expect(area.value).toBe("hello\n> q\n\n");
  });
});
