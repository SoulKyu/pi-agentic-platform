// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { CodeText } from "./CodeText.tsx";

describe("CodeText", () => {
  it("renders backticked runs as code and any markup as text", async () => {
    const page = await mount(<CodeText text="Run `pap doctor` then <b>retry</b>." />);
    const codes = [...page.container.querySelectorAll('code[data-slot="code-text"]')];
    expect(codes.map((code) => code.textContent)).toEqual(["pap doctor"]);
    expect(codes[0]?.className).toContain("font-mono");
    expect(codes[0]?.className).toContain("text-code");
    expect(page.container.querySelector("b")).toBeNull();
    expect(page.container.textContent).toBe("Run pap doctor then <b>retry</b>.");
  });
});
