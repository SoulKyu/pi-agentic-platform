import { EGRESS_UNKNOWN } from "@pap/contracts";
// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { NewAgentDialog } from "./NewAgentDialog.tsx";

const current: { runtime: Runtime | undefined } = { runtime: undefined };
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

async function open(settings: () => unknown) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  bed.handlers["settings.get"] = settings;
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <NewAgentDialog
          probe={{ usable: true, path: "/usr/bin/bwrap", reason: null, checkedAt: 1, egress: EGRESS_UNKNOWN }}
          presetField={() => null}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  await settle();
  return bed;
}
const networkOn = (): boolean | null => {
  const label = [...document.querySelectorAll("label")].find((one) => one.textContent === "Network");
  const control = document.getElementById(label?.htmlFor ?? "");
  return control === null ? null : control.getAttribute("aria-checked") === "true";
};
const offWarning = () => text(document.body).includes("This agent's commands run as you");

afterEach(() => vi.useRealTimers());

describe("the new-agent dialog starts from the agents settings (M11R99)", () => {
  it("reads the agents document once, and starts with the network on when the owner chose that", async () => {
    const bed = await open(() => ({
      value: { newAgent: { sandbox: { required: true, network: true } } },
      revision: 2,
    }));
    expect(bed.called("settings.get")).toEqual([expect.objectContaining({ params: { key: "agents" } })]);
    expect(networkOn()).toBe(true);
  });

  it("starts with the sandbox off when the owner chose that", async () => {
    await open(() => ({
      value: { newAgent: { sandbox: { required: false, network: false } } },
      revision: 2,
    }));
    expect(networkOn()).toBeNull();
    expect(offWarning()).toBe(true);
  });

  it("starts from the safe defaults when nothing is stored", async () => {
    await open(() => ({ value: null, revision: 0 }));
    expect(networkOn()).toBe(false);
    expect(offWarning()).toBe(false);
  });

  it("starts from the safe defaults when the document cannot be read", async () => {
    await open(() => {
      throw new RpcError("internal");
    });
    expect(networkOn()).toBe(false);
    expect(offWarning()).toBe(false);
  });

  it("starts from the safe defaults when the document holds nonsense", async () => {
    await open(() => ({ value: { newAgent: { sandbox: { required: "yes" } } }, revision: 1 }));
    expect(networkOn()).toBe(false);
    expect(offWarning()).toBe(false);
  });

  it("says Loading… while the defaults are being read", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
    bed.handlers["settings.get"] = () => new Promise(() => {});
    await mount(
      <TooltipProvider>
        <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
          <NewAgentDialog
            probe={{
              usable: true,
              path: "/usr/bin/bwrap",
              reason: null,
              checkedAt: 1,
              egress: EGRESS_UNKNOWN,
            }}
            presetField={() => null}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />
        </StepUpContext.Provider>
      </TooltipProvider>,
    );
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text(document.body)).toContain("Loading…");
    expect(networkOn()).toBeNull();
  });
  it("after 5 s without an answer starts from the safe defaults and says so", async () => {
    vi.useFakeTimers();
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
    bed.handlers["settings.get"] = () => new Promise(() => {});
    await mount(
      <TooltipProvider>
        <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
          <NewAgentDialog
            probe={{
              usable: true,
              path: "/usr/bin/bwrap",
              reason: null,
              checkedAt: 1,
              egress: EGRESS_UNKNOWN,
            }}
            presetField={() => null}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />
        </StepUpContext.Provider>
      </TooltipProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(text(document.body)).toContain("Loading…");
    expect(networkOn()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(text(document.body)).not.toContain("Loading…");
    expect(text(document.body)).toContain(
      "The defaults did not answer, so this form starts from the safe ones: sandbox on, network off.",
    );
    expect(networkOn()).toBe(false);
    expect(offWarning()).toBe(false);
  });
});
