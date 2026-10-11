import { UI_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";
import { createCustomPanels } from "./custom-panels.ts";

type Sent = Array<Record<string, unknown>>;

function setup() {
  const sent: Sent = [];
  const errors: Array<{ event: string; message: string }> = [];
  const logs: string[] = [];
  const panels = createCustomPanels(
    (record) => {
      sent.push(record);
      return true;
    },
    {
      newId: () => "p1",
      theme: ANSI_THEME,
      onError: (event, error) => void errors.push({ event, message: (error as Error).message }),
      log: (line) => void logs.push(line),
    },
  );
  return { sent, errors, logs, panels };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => void rejections.push(reason);
beforeEach(() => {
  rejections.length = 0;
  process.on("unhandledRejection", onRejection);
});
afterEach(() => {
  process.off("unhandledRejection", onRejection);
});

describe("custom panels: async extension callbacks", () => {
  it("reports a rejecting async handleInput once, closes the panel and leaves no unhandled rejection", async () => {
    const { sent, errors, panels } = setup();
    const result = panels.open((() => ({
      render: () => ["x"],
      handleInput: async () => {
        throw new Error("async key");
      },
    })) as never);
    await flush();
    panels.input("p1", "a");
    expect(await result).toBeUndefined();
    await flush();
    expect(errors).toEqual([{ event: "custom_input", message: "async key" }]);
    expect(sent.at(-1)).toEqual({ type: "custom_close", id: "p1" });
    expect(panels.count()).toBe(0);
    expect(rejections).toEqual([]);
  });

  it("reports a rejecting async render once, closes the panel and leaves no unhandled rejection", async () => {
    const { sent, errors, panels } = setup();
    const result = panels.open((() => ({
      render: async () => {
        throw new Error("async render");
      },
    })) as never);
    expect(await result).toBeUndefined();
    await flush();
    expect(errors).toEqual([{ event: "custom_render", message: "async render" }]);
    expect(sent).toEqual([{ type: "custom_close", id: "p1" }]);
    expect(rejections).toEqual([]);
  });

  it("reports a rejecting async dispose once and leaves no unhandled rejection", async () => {
    const { errors, panels } = setup();
    const result = panels.open((() => ({
      render: () => ["x"],
      dispose: async () => {
        throw new Error("async dispose");
      },
    })) as never);
    await flush();
    panels.cancelAll();
    expect(await result).toBeUndefined();
    await flush();
    expect(errors).toEqual([{ event: "custom_dispose", message: "async dispose" }]);
    expect(rejections).toEqual([]);
  });
});

describe("custom panels: the keybindings manager", () => {
  it("answers matches() for a TUI binding, and its SDK-only members are safe stubs", async () => {
    const { panels } = setup();
    let keys: Record<string, unknown> = {};
    void panels.open(((_t: unknown, _th: unknown, keybindings: Record<string, unknown>) => {
      keys = keybindings;
      return { render: () => ["x"] };
    }) as never);
    await flush();
    const manager = keys as unknown as {
      matches(data: string, id: string): boolean;
      reload(): void;
      getEffectiveConfig(): Record<string, unknown>;
    };
    expect(manager.matches("\u001b[A", "tui.editor.cursorUp")).toBe(true);
    expect(manager.matches("\u001b[B", "tui.editor.cursorUp")).toBe(false);
    expect(manager.reload()).toBeUndefined();
    expect(manager.getEffectiveConfig()["tui.editor.cursorUp"]).toBe("up");
  });
});

describe("custom panels: dropped input is logged once per panel", () => {
  it("logs an oversize key and a key before the first render, once each panel, with stable codes", async () => {
    const { logs, panels } = setup();
    let finish: (component: unknown) => void = () => {};
    const keys: string[] = [];
    void panels.open(() => new Promise((resolve) => (finish = resolve)) as never);
    await flush();
    panels.input("p1", "early");
    panels.input("p1", "early again");
    expect(logs).toEqual(["custom_input_before_render"]);
    finish({ render: () => ["x"], handleInput: (d: string) => keys.push(d) });
    await flush();
    panels.input("p1", "k".repeat(UI_LIMITS.panelInput + 1));
    panels.input("p1", "k".repeat(UI_LIMITS.panelInput + 1));
    panels.input("p1", "ok");
    expect(logs).toEqual(["custom_input_before_render", "custom_input_too_long"]);
    expect(keys).toEqual(["ok"]);
  });
});
