// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../../runtime/index.ts";
import { alerts, button, click, field, mount, settle, text, typeInto } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { SaveTemplateDialog } from "./SaveTemplateDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let ids = 0;
const stepUp = (async (run: (commandId: string) => Promise<unknown>) =>
  run(`cmd-${++ids}`)) as unknown as StepUpRunner;
const onClose = vi.fn();
const zeroWidth = String.fromCodePoint(0x200b);

const open = (body = "Review $1 now") =>
  mount(
    <StepUpContext.Provider value={stepUp}>
      <SaveTemplateDialog text={body} onClose={onClose} />
    </StepUpContext.Provider>,
  );
const dialog = () => document.body;

beforeEach(() => {
  setLocale("en");
  ids = 0;
  onClose.mockReset();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
});

describe("SaveTemplateDialog", () => {
  it("the body is prefilled with hidden characters stripped; the help line names $1, $@ and ${1:-", async () => {
    await open(`Re${zeroWidth}view $1`);
    expect(field(dialog(), "Prompt").value).toBe("Review $1");
    const words = text(dialog());
    expect(words).toContain("$1");
    expect(words).toContain("$@");
    expect(words).toContain("${1:-");
    expect(document.querySelector("[data-save-template]")).not.toBeNull();
  });

  it("an invalid or reserved name disables Save and says why", async () => {
    await open();
    const save = () => button(dialog(), "Save");
    expect(save().disabled).toBe(true);
    await typeInto(field(dialog(), "Name"), "Bad Name");
    expect(save().disabled).toBe(true);
    expect(text(dialog())).toContain("Use lower-case letters, digits and hyphens");
    await typeInto(field(dialog(), "Name"), "compact");
    expect(save().disabled).toBe(true);
    expect(text(dialog())).toContain("Pi already has a /compact command: choose another name.");
    await typeInto(field(dialog(), "Name"), "review");
    expect(save().disabled).toBe(false);
  });

  it("Save runs through the step-up runner with a command id and says Saved as /review", async () => {
    bed.handlers["templates.save"] = () => ({ name: "review", replaced: false });
    await open();
    await typeInto(field(dialog(), "Name"), "review");
    await typeInto(field(dialog(), "Description (optional)"), "A review");
    await click(button(dialog(), "Save"));
    await settle();
    const [call] = bed.called("templates.save");
    expect(call?.params).toEqual({ name: "review", description: "A review", body: "Review $1 now" });
    expect(call?.options?.commandId).toBe("cmd-1");
    const words = text(dialog());
    expect(words).toContain("Saved as /review.");
    expect(words).toContain("sessions started from now on");
    expect(words).toContain("Pi profile image build");
  });

  it("conflict offers Replace, which sends replace: true with a new command id", async () => {
    let first = true;
    bed.handlers["templates.save"] = () => {
      if (first) {
        first = false;
        throw new RpcError("conflict");
      }
      return { name: "review", replaced: true };
    };
    await open();
    await typeInto(field(dialog(), "Name"), "review");
    await click(button(dialog(), "Save"));
    await settle();
    expect(alerts(dialog()).join(" ")).toContain("A template named /review already exists.");
    await click(button(dialog(), "Replace"));
    await settle();
    const calls = bed.called("templates.save");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual({ name: "review", body: "Review $1 now", replace: true });
    expect(calls[1]?.options?.commandId).toBe("cmd-2");
    expect(text(dialog())).toContain("Saved as /review.");
  });

  it("an error shows its copy as an alert", async () => {
    bed.handlers["templates.save"] = () => {
      throw new RpcError("pi_busy");
    };
    await open();
    await typeInto(field(dialog(), "Name"), "review");
    await click(button(dialog(), "Save"));
    await settle();
    expect(alerts(dialog())).toHaveLength(1);
  });

  it("a body over 32 KiB cannot be sent", async () => {
    await open("x".repeat(32 * 1024 + 1));
    await typeInto(field(dialog(), "Name"), "review");
    expect(button(dialog(), "Save").disabled).toBe(true);
    expect(text(dialog())).toContain("At most 32 KiB.");
    expect(bed.called("templates.save")).toHaveLength(0);
  });
});
