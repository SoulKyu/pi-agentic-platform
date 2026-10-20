// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ClaudeToken } from "./ClaudeToken.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const SECRET = "sk-ant-oat01-super-secret-value";
let bed: ReturnType<typeof fakeRuntime>;
const changed = vi.fn();
const stepUp = vi.fn();

async function show(state: "set" | "missing") {
  await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <ClaudeToken state={state} onChanged={changed} />
    </StepUpContext.Provider>,
  );
  await settle();
}
const body = () => text(document.body);
const tokenField = () => field(document.body, "Claude token");

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  changed.mockReset();
  stepUp.mockReset();
  stepUp.mockImplementation(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));
});

describe("the Claude token field", () => {
  it("says Missing and offers the field", async () => {
    await show("missing");
    expect(body()).toContain("Missing");
    expect(tokenField().type).toBe("password");
    expect(tokenField().autocomplete).toBe("off");
    expect(hasButton(document.body, "Remove")).toBe(false);
  });

  it("says Saved and shows no field and no value, only Replace and Remove", async () => {
    await show("set");
    expect(body()).toContain("Saved");
    expect(document.querySelector("input")).toBeNull();
    expect(hasButton(document.body, "Replace")).toBe(true);
    expect(hasButton(document.body, "Remove")).toBe(true);
  });

  it("sends the token through the step-up, empties the field at once and never shows it again", async () => {
    await show("missing");
    await typeInto(tokenField(), `  ${SECRET}  `);
    await click(button(document.body, "Save"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.vm.setClaudeToken")).toEqual([
      expect.objectContaining({ params: { token: SECRET } }),
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(tokenField().value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain(SECRET);
    expect(document.documentElement.outerHTML).not.toContain("super-secret");
  });

  it("keeps the value out of the page when the save fails", async () => {
    await show("missing");
    bed.handlers["agents.vm.setClaudeToken"] = () => {
      throw new RpcError("sandbox_unavailable");
    };
    await typeInto(tokenField(), SECRET);
    await click(button(document.body, "Save"));
    await settle();
    expect(alerts(document.body)).toHaveLength(1);
    expect(tokenField().value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain("super-secret");
    expect(changed).not.toHaveBeenCalled();
  });

  it("refuses an empty or over-long token without sending it", async () => {
    await show("missing");
    for (const bad of [" ", "x".repeat(513)]) {
      await typeInto(tokenField(), bad);
      if (bad.trim() !== "") await click(button(document.body, "Save"));
    }
    expect(button(document.body, "Save").disabled).toBe(true);
    expect(bed.called("agents.vm.setClaudeToken")).toEqual([]);
  });

  it("Replace opens the field, Cancel closes it", async () => {
    await show("set");
    await click(button(document.body, "Replace"));
    expect(tokenField().value).toBe("");
    await click(button(document.body, "Cancel"));
    expect(document.querySelector("input")).toBeNull();
  });

  it("Remove calls clearClaudeToken through the step-up", async () => {
    await show("set");
    await click(button(document.body, "Remove"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.vm.clearClaudeToken")).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("says Enregistré and Manquant in French", async () => {
    setLocale("fr");
    await show("set");
    expect(body()).toContain("Enregistré");
    document.body.replaceChildren();
    await show("missing");
    expect(body()).toContain("Manquant");
  });
});
