// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { button, click, mount, press, settle, text } from "../../testing/dom.ts";
import { TrustDialog } from "./TrustDialog.tsx";
import { current, CWD, newBed, prompt, serverOf, statusOf, withStepUp } from "./trust-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const decided = vi.fn();
const closed = vi.fn();
async function open() {
  decided.mockClear();
  closed.mockClear();
  const page = await mount(withStepUp(<TrustDialog cwd={CWD} onDecided={decided} onClose={closed} />));
  await settle();
  return page;
}
const body = () => text(document.body);

describe("trust dialog (M7R109)", () => {
  it("loads trust.status on open and lists a masked server, an extension, a skill, the templates and the settings keys", async () => {
    const bed = newBed(
      statusOf({
        mcpServers: [
          serverOf({
            name: "gh",
            kind: "http",
            target: "https://api.example/mcp?token=•••",
            variables: ["GITHUB_TOKEN"],
          }),
        ],
      }),
    );
    await open();
    expect(bed.called("trust.status")[0]?.params).toEqual({ cwd: CWD });
    expect(body()).toContain("gh");
    expect(body()).toContain("https://api.example/mcp?token=•••");
    expect(body()).toContain("sends GITHUB_TOKEN to this server");
    expect(body()).toContain("deploy.ts");
    expect(body()).toContain("review");
    expect(body()).toContain("Prompt templates: 2");
    expect(body()).toContain("packages");
  });

  it("escapes hidden characters of every name that comes from the project, as text", async () => {
    newBed(
      statusOf({
        mcpServers: [serverOf({ name: "a‮b" })],
        extensions: ["x​y.ts"],
        skills: ["s k"],
        settingsKeys: ["k\u0007"],
        unlisted: [".pi/extensions: a‮ link"],
        truncated: true,
      }),
    );
    await open();
    expect(body()).toContain("a\\u202Eb");
    expect(body()).toContain("x\\u200By.ts");
    expect(body()).toContain("s\\u00A0k");
    expect(body()).toContain("k\\u0007");
    expect(body()).toContain(".pi/extensions: a\\u202E link");
    expect(body()).not.toContain("‮");
    expect(document.body.innerHTML).not.toContain("<script");
  });

  it("lists the resources inside the dashed attention frame of external content", async () => {
    newBed();
    await open();
    const frame = document.body.querySelector("[data-trust-resources]");
    expect(frame?.className).toContain("border-dashed");
    expect(frame?.className).toContain("border-attn");
    expect(frame?.textContent).toContain("deploy.ts");
  });

  it("says pap could not list everything when something is unlisted, with the reasons", async () => {
    newBed(statusOf({ unlisted: [".pi/skills: a link outside the folder"] }));
    await open();
    expect(body()).toContain("pap could not list everything");
    expect(body()).toContain(".pi/skills: a link outside the folder");
  });

  it("says it too when a list was cut, even with no reason named", async () => {
    newBed(statusOf({ truncated: true }));
    await open();
    expect(body()).toContain("pap could not list everything");
  });

  it("does not say it when the list is complete", async () => {
    newBed();
    await open();
    expect(body()).not.toContain("could not list everything");
  });

  it("Trust asks the password (step-up), then sends trust.set { decision: true } once and reports the decision", async () => {
    const bed = newBed();
    let first = true;
    bed.handlers["trust.set"] = () => {
      if (first) {
        first = false;
        return Promise.reject(new RpcError("step_up_required"));
      }
      return { ok: true };
    };
    await open();
    await click(button(document.body, "Trust"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(bed.called("trust.set").map((call) => call.params)).toEqual([
      { cwd: CWD, decision: true },
      { cwd: CWD, decision: true },
    ]);
    expect(bed.called("trust.set")[0]?.options?.commandId).toBe(
      bed.called("trust.set")[1]?.options?.commandId,
    );
    expect(decided).toHaveBeenCalledWith(true);
  });

  it("a cancelled step-up changes nothing and leaves the dialog open", async () => {
    const bed = newBed();
    bed.handlers["trust.set"] = () => Promise.reject(new RpcError("step_up_required"));
    prompt.answer = false;
    await open();
    await click(button(document.body, "Trust"));
    await settle();
    expect(decided).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(body()).toContain("Trust this project?");
  });

  it("Keep untrusted sends decision false and never prompts", async () => {
    const bed = newBed();
    await open();
    await click(button(document.body, "Keep untrusted"));
    await settle();
    expect(bed.called("trust.set").map((call) => call.params)).toEqual([{ cwd: CWD, decision: false }]);
    expect(prompt.asked).toBe(0);
    expect(decided).toHaveBeenCalledWith(false);
  });

  it("Cancel closes without a call and is not a danger button", async () => {
    const bed = newBed();
    await open();
    const cancel = button(document.body, "Cancel");
    expect(cancel.getAttribute("data-variant")).not.toBe("danger");
    await click(cancel);
    expect(closed).toHaveBeenCalled();
    expect(bed.called("trust.set")).toEqual([]);
  });

  it.each([
    ["filesystem-root", "the whole disk"],
    ["home-or-above", "your home folder"],
    ["holds-pi-or-pap", "Pi's own folder or pap's"],
    ["holds-other-projects", "holds other projects"],
  ] as const)(
    "shows the copy of the %s refusal (a result, not an error) and records no decision",
    async (refusal, words) => {
      const bed = newBed(statusOf(), { ok: false, refusal });
      await open();
      await click(button(document.body, "Trust"));
      await settle();
      expect(body()).toContain(words);
      expect(decided).not.toHaveBeenCalled();
      expect(bed.called("trust.set")).toHaveLength(1);
    },
  );

  it("shows the capacity answer as an error", async () => {
    const bed = newBed();
    bed.handlers["trust.set"] = () => Promise.reject(new RpcError("capacity"));
    await open();
    await click(button(document.body, "Trust"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "The server is at capacity. Try again later.",
    );
    expect(decided).not.toHaveBeenCalled();
  });

  it("a failed status read shows its error and cannot Trust what it could not read", async () => {
    const bed = newBed();
    bed.handlers["trust.status"] = () => Promise.reject(new RpcError("forbidden"));
    await open();
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(button(document.body, "Trust").disabled).toBe(true);
  });

  it("says when the decision applies, in the words the banner uses", async () => {
    newBed();
    await open();
    expect(body()).toContain("applies when Pi restarts for the session");
  });

  it("says the outcome is unknown after a timeout, and reads the status again", async () => {
    const bed = newBed();
    bed.handlers["trust.set"] = () => Promise.reject(new RpcError("timeout"));
    await open();
    await click(button(document.body, "Keep untrusted"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "does not know whether the decision was saved",
    );
    expect(bed.called("trust.status")).toHaveLength(2);
    expect(bed.called("trust.set")).toHaveLength(1);
    expect(decided).not.toHaveBeenCalled();
  });

  const escape = () => press(document.activeElement ?? document.body, { key: "Escape" });

  it("Esc closes the dialog when idle", async () => {
    newBed();
    await open();
    await escape();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("Esc, Cancel and the close button do nothing while a decision is in flight", async () => {
    const bed = newBed();
    bed.handlers["trust.set"] = () => new Promise(() => {});
    await open();
    await click(button(document.body, "Keep untrusted"));
    await escape();
    expect(button(document.body, "Cancel").disabled).toBe(true);
    await click(button(document.body, "Close"));
    expect(closed).not.toHaveBeenCalled();
  });

  it("gives focus back to the button that opened it", async () => {
    newBed();
    function Opener() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button onClick={() => setShown(true)}>Review</button>
          {shown ? <TrustDialog cwd={CWD} onDecided={decided} onClose={() => setShown(false)} /> : null}
        </>
      );
    }
    const page = await mount(withStepUp(<Opener />));
    const opener = button(page.container, "Review");
    opener.focus();
    await click(opener);
    await settle();
    await escape();
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("speaks French", async () => {
    setLocale("fr");
    newBed();
    await open();
    expect(body()).toContain("Faire confiance à ce projet ?");
    expect(() => button(document.body, "Faire confiance")).not.toThrow();
    expect(() => button(document.body, "Rester non fiable")).not.toThrow();
  });
});
