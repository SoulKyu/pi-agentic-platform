import { AUTOMATION_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { newFenceId, RENDERED_PROMPT_MAX, renderPrompt } from "./prompt.ts";

const values = {
  payload: null,
  precheck: null,
  trigger: "Nightly",
  firedAt: "2026-10-14T01:00:00.000Z",
};
const ids = (...list: string[]) => {
  const queue = [...list];
  return () => queue.shift() ?? "000000000000";
};

describe("renderPrompt", () => {
  it("fences an Alertmanager payload in pap's one format, at the placeholder", () => {
    const rendered = renderPrompt(
      "Alert: {{payload}}\nPlease look.",
      { ...values, payload: { text: "firing critical HighCPU", source: "alertmanager" } },
      ids("aaaaaaaaaaaa"),
    );
    expect(rendered).toEqual({
      text: 'Alert: <untrusted source="alertmanager" id="aaaaaaaaaaaa">\nfiring critical HighCPU\n</untrusted id="aaaaaaaaaaaa">\nPlease look.',
      fenced: true,
    });
  });

  it("keeps a placeholder written inside the payload as text (one pass)", () => {
    const rendered = renderPrompt(
      "{{payload}} / {{precheck}}",
      { ...values, payload: { text: "see {{precheck}} and {{trigger}}", source: "webhook" }, precheck: "ok" },
      ids("aaaaaaaaaaaa", "bbbbbbbbbbbb"),
    );
    expect(rendered.text).toContain("see {{precheck}} and {{trigger}}");
    expect(rendered.text.match(/<untrusted /g)).toHaveLength(2);
  });

  it("adds a payload the template does not place at the end, fenced, never bare", () => {
    const rendered = renderPrompt(
      "Check the repo.",
      { ...values, payload: { text: "hello", source: "webhook" } },
      ids("cccccccccccc"),
    );
    expect(rendered).toEqual({
      text: 'Check the repo.\n\n<untrusted source="webhook" id="cccccccccccc">\nhello\n</untrusted id="cccccccccccc">',
      fenced: true,
    });
  });

  it("strips format characters (tag characters, bidi, zero-width) and controls except newline and tab, from every fenced input", () => {
    const hidden = "\u{E0049}\u{E0047}\u202E\u200B\u0000\u0007\u0085\r";
    const rendered = renderPrompt(
      "{{precheck}}|{{payload}}",
      { ...values, precheck: `a${hidden}\tb\nc`, payload: { text: `x${hidden}y`, source: "webhook" } },
      ids("aaaaaaaaaaaa", "bbbbbbbbbbbb"),
    );
    expect(rendered.text).toBe(
      '<untrusted source="precheck" id="aaaaaaaaaaaa">\na\tb\nc\n</untrusted id="aaaaaaaaaaaa">|' +
        '<untrusted source="webhook" id="bbbbbbbbbbbb">\nxy\n</untrusted id="bbbbbbbbbbbb">',
    );
  });

  it("fences the precheck output", () => {
    const rendered = renderPrompt(
      "Output: {{precheck}}",
      { ...values, precheck: "3 failing" },
      ids("dddddddddddd"),
    );
    expect(rendered).toEqual({
      text: 'Output: <untrusted source="precheck" id="dddddddddddd">\n3 failing\n</untrusted id="dddddddddddd">',
      fenced: true,
    });
  });

  it("leaves a schedule prompt unfenced, with the trigger and the time in plain text", () => {
    expect(renderPrompt("Run {{trigger}} at {{ firedAt }}", values)).toEqual({
      text: "Run Nightly at 2026-10-14T01:00:00.000Z",
      fenced: false,
    });
  });

  it("drops NUL before fencing and leaves an unknown placeholder alone", () => {
    const rendered = renderPrompt(
      "{{payload}} {{nope}}",
      { ...values, payload: { text: "a\u0000b", source: "webhook" } },
      ids("eeeeeeeeeeee"),
    );
    expect(rendered.text).toBe(
      '<untrusted source="webhook" id="eeeeeeeeeeee">\nab\n</untrusted id="eeeeeeeeeeee"> {{nope}}',
    );
  });

  it("gives two fences in one prompt two different fresh ids", () => {
    const rendered = renderPrompt("{{payload}}{{precheck}}", {
      ...values,
      payload: { text: "a", source: "webhook" },
      precheck: "b",
    });
    const found = [...rendered.text.matchAll(/id="([0-9a-f]{12})"/g)].map((match) => match[1]);
    expect(found).toHaveLength(4);
    expect(found[0]).toBe(found[1]);
    expect(found[2]).toBe(found[3]);
    expect(found[0]).not.toBe(found[2]);
    expect(newFenceId()).toMatch(/^[0-9a-f]{12}$/);
    expect(newFenceId()).not.toBe(newFenceId());
  });

  it("stays under the stored cap in the worst case: a 16 000 character template, a 64 KiB payload, 4 KiB of precheck", () => {
    const filler = "x".repeat(AUTOMATION_LIMITS.promptChars - 1_000);
    const template = `${filler} {{payload}} {{precheck}} {{trigger}} {{firedAt}}`;
    const rendered = renderPrompt(template, {
      payload: { text: "p".repeat(AUTOMATION_LIMITS.payloadBytes), source: "alertmanager" },
      precheck: "c".repeat(AUTOMATION_LIMITS.precheckOutputBytes),
      trigger: "t".repeat(320),
      firedAt: "2026-10-14T01:00:00.000Z",
    });
    expect(rendered.text.length).toBeLessThan(RENDERED_PROMPT_MAX);
    expect(rendered.text.length).toBeGreaterThan(AUTOMATION_LIMITS.payloadBytes);
  });
});
