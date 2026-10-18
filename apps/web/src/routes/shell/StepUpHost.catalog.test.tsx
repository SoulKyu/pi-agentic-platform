// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { mount, settle, text } from "../../testing/dom.ts";
import { StepUpHost } from "./StepUpHost.tsx";
import { ShellContext } from "./shell-context.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";

// No catalog is registered here: the prompt must bring its own strings with its chunk (a Save before Settings loaded).
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { newCommandId: () => "cmd-1" } }),
}));

const shell = { username: "me", passkeysAvailable: true, onSignedOut: vi.fn() };
const RAW_KEY = /^[a-z]+(\.[a-zA-Z]+)+$/;

function Asker() {
  const stepUp = useStepUpRunner();
  return (
    <button
      type="button"
      onClick={() => {
        void stepUp(() => Promise.reject(new RpcError("step_up_required")));
      }}
    >
      save
    </button>
  );
}

describe("the shell's password prompt before the Settings chunk loaded", () => {
  it("shows English text, never a raw catalog key", async () => {
    await mount(
      <ShellContext.Provider value={shell}>
        <StepUpHost>
          <Asker />
        </StepUpHost>
      </ShellContext.Provider>,
    );
    (document.body.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(text(document.body)).toContain("Confirm your password"), { timeout: 4000 });
    await settle();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const raw: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const value = (node.textContent ?? "").trim();
      if (RAW_KEY.test(value)) raw.push(value);
    }
    expect(raw).toEqual([]);
  });
});
