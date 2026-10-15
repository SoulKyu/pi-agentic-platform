// @vitest-environment happy-dom
import type { LanePreview } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { mount } from "../../testing/dom.ts";
import { inShell } from "./lanes-bed.tsx";
import { ScriptTrust } from "./ScriptTrust.tsx";

type Script = LanePreview["config"]["scripts"][number];
const script = (patch: Partial<Script>): Script => ({
  kind: "setup",
  text: "make",
  sha256: "a".repeat(64),
  approved: false,
  previous: null,
  ...patch,
});
const pres = (container: HTMLElement) =>
  [...container.querySelectorAll("pre")].map((node) => node.textContent);

describe("script approval box shows hidden characters (M9 sweep, item 2)", () => {
  it("writes bidi, zero-width and control characters as escapes in the new and the old text", async () => {
    const page = await mount(
      inShell(<ScriptTrust script={script({ text: "echo ‮ok​\u0007", previous: "rm⁦ -rf x" })} />),
    );
    expect(pres(page.container)).toEqual(["rm\\u2066 -rf x", "echo \\u202Eok\\u200B\\u0007"]);
  });

  it("keeps line breaks and tabs readable", async () => {
    const page = await mount(inShell(<ScriptTrust script={script({ text: "a\n\tb\nc" })} />));
    expect(pres(page.container)).toEqual(["a\n\tb\nc"]);
  });
});

describe("the approval box shows the size of the text (M6)", () => {
  const size = (page: { container: HTMLElement }) =>
    page.container.querySelector('[data-slot="script-size"]')?.textContent;

  it("counts lines and characters, so blank padding cannot hide behind the scrollbar", async () => {
    const page = await mount(
      inShell(<ScriptTrust script={script({ text: `echo ok${"\n".repeat(300)}` })} />),
    );
    expect(size(page)).toBe("301 lines · 307 characters");
  });

  it("counts both texts of a changed script, and says one line in the singular", async () => {
    const page = await mount(inShell(<ScriptTrust script={script({ text: "make", previous: "a\nb" })} />));
    const sizes = [...page.container.querySelectorAll('[data-slot="script-size"]')].map((n) => n.textContent);
    expect(sizes).toEqual(["2 lines · 3 characters", "1 line · 4 characters"]);
  });
});
