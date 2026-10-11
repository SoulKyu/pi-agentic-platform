import { UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";
import { createCustomPanels, PANEL_COLUMNS } from "./custom-panels.ts";

type Sent = Array<Record<string, unknown>>;

function setup(sendOk = true) {
  const sent: Sent = [];
  const errors: string[] = [];
  let ids = 0;
  const panels = createCustomPanels(
    (record) => {
      sent.push(record);
      return sendOk;
    },
    { newId: () => `p${++ids}`, theme: ANSI_THEME, onError: (event) => void errors.push(event) },
  );
  return { sent, errors, panels };
}

/** Timers that never fire by themselves: a test fires the due ones. */
function fakeTimers() {
  const due: Array<() => void> = [];
  return {
    due,
    timers: {
      setTimer: (fn: () => void) => {
        due.push(fn);
        return fn;
      },
      clearTimer: (handle: unknown) => {
        const at = due.indexOf(handle as never);
        if (at !== -1) due.splice(at, 1);
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const picker =
  (widths: number[]) => (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: string) => void) => {
    let cursor = 0;
    const items = ["alpha", "beta"];
    return {
      render: (width: number) => {
        widths.push(width);
        return items.map((item, i) => `${i === cursor ? ">" : " "} ${item}`);
      },
      handleInput: (data: string) => {
        if (data === "\u001b[B") cursor = 1;
        else if (data === "\r") done(items[cursor] ?? "");
      },
      invalidate: () => {},
    };
  };

describe("custom panels", () => {
  it("renders, takes keys, closes once and never renders after done", async () => {
    const { sent, panels } = setup();
    const widths: number[] = [];
    const result = panels.open<string>(picker(widths) as never);
    await flush();
    panels.input("p1", "\u001b[B");
    panels.input("p1", "\r");
    expect(await result).toBe("beta");
    expect(sent).toEqual([
      { type: "custom_render", id: "p1", lines: ["> alpha", "  beta"] },
      { type: "custom_render", id: "p1", lines: ["  alpha", "> beta"] },
      { type: "custom_close", id: "p1" },
    ]);
    expect(widths).toEqual([PANEL_COLUMNS, PANEL_COLUMNS]);
    panels.input("p1", "x");
    expect(sent).toHaveLength(3);
    expect(panels.count()).toBe(0);
  });

  it("disposes a component whose factory resolves after the panel was cancelled", async () => {
    const { panels } = setup();
    let disposed = false;
    let finish: (component: unknown) => void = () => {};
    const result = panels.open(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as never,
    );
    panels.cancelAll();
    expect(await result).toBeUndefined();
    finish({ render: () => [], dispose: () => (disposed = true) });
    await flush();
    expect(disposed).toBe(true);
  });

  it("closes a panel whose render throws or cannot be sent, and reports the throw", async () => {
    const throwing = setup();
    const result = throwing.panels.open(((): unknown => ({
      render: () => {
        throw new Error("boom");
      },
    })) as never);
    expect(await result).toBeUndefined();
    expect(throwing.errors).toEqual(["custom_render"]);
    const unsendable = setup(false);
    expect(await unsendable.panels.open((() => ({ render: () => ["x"] })) as never)).toBeUndefined();
    expect(unsendable.panels.count()).toBe(0);
  });

  it("closes a panel whose factory or handleInput throws, and reports it", async () => {
    const factory = setup();
    expect(
      await factory.panels.open((() => {
        throw new Error("no factory");
      }) as never),
    ).toBeUndefined();
    expect(factory.errors).toEqual(["custom_factory"]);
    expect(factory.sent).toEqual([{ type: "custom_close", id: "p1" }]);

    const input = setup();
    let disposed = 0;
    const result = input.panels.open(((): unknown => ({
      render: () => ["x"],
      handleInput: () => {
        throw new Error("key");
      },
      dispose: () => disposed++,
    })) as never);
    await flush();
    input.panels.input("p1", "a");
    expect(await result).toBeUndefined();
    expect(input.errors).toEqual(["custom_input"]);
    expect(disposed).toBe(1);
    expect(input.sent.at(-1)).toEqual({ type: "custom_close", id: "p1" });
  });

  it("reports a throwing dispose and still closes", async () => {
    const { sent, errors, panels } = setup();
    const result = panels.open(((_t: unknown, _th: unknown, _k: unknown, done: (v: string) => void) => {
      return {
        render: () => {
          queueMicrotask(() => done("v"));
          return ["x"];
        },
        dispose: () => {
          throw new Error("dispose");
        },
      };
    }) as never);
    expect(await result).toBe("v");
    expect(errors).toEqual(["custom_dispose"]);
    expect(sent.at(-1)).toEqual({ type: "custom_close", id: "p1" });
  });

  it("cuts lines at the source", async () => {
    const { sent, panels } = setup();
    void panels.open((() => ({
      render: () => Array.from({ length: 500 }, () => "y".repeat(2000)),
    })) as never);
    await flush();
    const lines = (sent[0] as { lines: string[] }).lines;
    expect(lines).toHaveLength(UI_LIMITS.panelLines);
    expect(lines[0]).toHaveLength(UI_LIMITS.panelLineChars);
  });

  it("strips hostile escape sequences from rendered lines but keeps SGR", async () => {
    const { sent, panels } = setup();
    void panels.open((() => ({
      render: () => [
        "\u001b[31mred\u001b[0m \u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007 \u001b[2J\u001b[H\u0007done",
        "\u001b]0;title\u001b\\after \u001bP1$r\u001b\\x \u001b[?1049h\u001b[1;1H y",
      ],
    })) as never);
    await flush();
    expect((sent[0] as { lines: string[] }).lines).toEqual([
      "\u001b[31mred\u001b[0m link done",
      "after x  y",
    ]);
  });

  it("fails a panel beyond the cap, clearly, without sending anything for it", async () => {
    const { sent, errors, panels } = setup();
    const opened = Array.from({ length: UI_LIMITS.panels }, () =>
      panels.open((() => ({ render: () => ["x"] })) as never),
    );
    await flush();
    expect(panels.count()).toBe(UI_LIMITS.panels);
    const before = sent.length;
    expect(await panels.open((() => ({ render: () => ["x"] })) as never)).toBeUndefined();
    expect(errors).toEqual(["custom_open"]);
    expect(sent).toHaveLength(before);
    panels.cancelAll();
    await Promise.all(opened);
    expect(panels.count()).toBe(0);
  });

  it("ignores input that is too long or for an unknown panel", async () => {
    const { panels } = setup();
    const keys: string[] = [];
    void panels.open((() => ({ render: () => ["x"], handleInput: (d: string) => keys.push(d) })) as never);
    await flush();
    panels.input("p1", "k".repeat(UI_LIMITS.panelInput + 1));
    panels.input("nope", "k");
    panels.input("p1", "k");
    expect(keys).toEqual(["k"]);
  });

  it("cancel(id) and cancelAll settle each open panel exactly once, with one close each", async () => {
    const { sent, panels } = setup();
    let disposed = 0;
    const make = () => ({ render: () => ["x"], dispose: () => disposed++ });
    const a = panels.open(make as never);
    const b = panels.open(make as never);
    await flush();
    panels.cancel("p1");
    panels.cancel("p1");
    panels.cancelAll();
    panels.cancelAll();
    expect(await Promise.all([a, b])).toEqual([undefined, undefined]);
    expect(sent.filter((r) => r.type === "custom_close")).toEqual([
      { type: "custom_close", id: "p1" },
      { type: "custom_close", id: "p2" },
    ]);
    expect(disposed).toBe(2);
  });

  it("coalesces requestRender into one render per 50 ms, and leaves no timer after done (M2-RT-18)", async () => {
    const { due, timers } = fakeTimers();
    const sent: Sent = [];
    let ticks = 0;
    let requestRender = () => {};
    let finish: (value: string) => void = () => {};
    const panels = createCustomPanels(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: () => "p1", theme: ANSI_THEME, onError: () => {}, timers },
    );
    const result = panels.open<string>(((
      tui: { requestRender(): void },
      _theme: unknown,
      _keys: unknown,
      done: (value: string) => void,
    ) => {
      requestRender = () => tui.requestRender();
      finish = done;
      return { render: () => [`ticks: ${ticks}`], invalidate: () => {} };
    }) as never);
    await flush();
    for (ticks = 1; ticks <= 60; ticks++) requestRender();
    expect(sent).toHaveLength(1);
    expect(due).toHaveLength(1);
    for (const fire of due.splice(0)) fire();
    expect(sent.at(-1)).toEqual({ type: "custom_render", id: "p1", lines: ["ticks: 61"] });
    requestRender();
    finish("done");
    expect(await result).toBe("done");
    expect(due).toEqual([]);
  });

  it("drops a render that arrives after done (the stray render), and clears the timer on cancel", async () => {
    const { due, timers } = fakeTimers();
    const sent: Sent = [];
    let requestRender = () => {};
    const panels = createCustomPanels(
      (record) => {
        sent.push(record);
        return true;
      },
      { newId: () => "p1", theme: ANSI_THEME, onError: () => {}, timers },
    );
    const result = panels.open(((
      tui: { requestRender(): void },
      _t: unknown,
      _k: unknown,
      done: (v: string) => void,
    ) => {
      requestRender = () => tui.requestRender();
      return { render: () => ["x"], handleInput: () => done("end") };
    }) as never);
    await flush();
    requestRender();
    const [stale] = [...due];
    panels.input("p1", "k");
    expect(await result).toBe("end");
    stale?.();
    requestRender();
    expect(due).toEqual([]);
    expect(sent.map((r) => r.type)).toEqual(["custom_render", "custom_close"]);

    const second = createCustomPanels(() => true, {
      newId: () => "p2",
      theme: ANSI_THEME,
      onError: () => {},
      timers,
    });
    let again = () => {};
    void second.open(((tui: { requestRender(): void }) => {
      again = () => tui.requestRender();
      return { render: () => ["x"] };
    }) as never);
    await flush();
    again();
    expect(due).toHaveLength(1);
    second.cancelAll();
    expect(due).toEqual([]);
  });
});
