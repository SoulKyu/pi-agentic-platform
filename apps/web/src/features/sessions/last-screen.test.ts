// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { rememberScreen, targetScreen } from "./last-screen.ts";

afterEach(() => {
  rememberScreen(null);
  document.body.replaceChildren();
});

const screenElement = () => {
  const el = document.createElement("div");
  el.setAttribute("data-session-screen", "");
  document.body.append(el);
  return el;
};

describe("the screen a palette command goes to", () => {
  it("is the remembered screen while it is attached", () => {
    const el = screenElement();
    rememberScreen(el);
    expect(targetScreen(null)).toBe(el);
  });

  it("is never a removed screen", () => {
    const el = screenElement();
    rememberScreen(el);
    el.remove();
    expect(targetScreen(null)).toBeNull();
  });

  it("is the screen holding the focus before any remembered one", () => {
    const remembered = screenElement();
    const holder = screenElement();
    const inner = document.createElement("input");
    holder.append(inner);
    rememberScreen(remembered);
    expect(targetScreen(inner)).toBe(holder);
  });
});
