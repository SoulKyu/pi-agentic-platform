// @vitest-environment happy-dom
import type { QuarantineResult } from "@pap/contracts";
import { useState } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { alerts, button, click, hasButton, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { QuarantineDialog } from "./QuarantineDialog.tsx";

// Every zustand store the app creates, so the leak test can read all of them.
const stores = vi.hoisted(() => [] as Array<{ getState(): unknown }>);
vi.mock("zustand", async (original) => {
  const real = await original<typeof import("zustand")>();
  type Store = { getState(): unknown };
  const track = (store: unknown): unknown => {
    stores.push(store as Store);
    return store;
  };
  const make = real.create as unknown as (init?: unknown) => unknown;
  const create = (init?: unknown) =>
    init === undefined
      ? (curried: unknown) => track((make() as (c: unknown) => unknown)(curried))
      : track(make(init));
  return { ...real, create };
});
const reported = vi.hoisted(() => vi.fn());
vi.mock("../../lib/report.ts", async (original) => ({
  ...(await original<typeof import("../../lib/report.ts")>()),
  reportClientIssue: reported,
}));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// Anything a toast says is a leak surface too.
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: toasts,
}));

const HOOK_SECRET = "whsec_Qm4-rotated-7731";
const SECOND_SECRET = "whsec_Zt8-rotated-2209";
const result = (patch: Partial<QuarantineResult> = {}): QuarantineResult => ({
  secrets: [
    { triggerId: "g1", name: "Deploy hook", secret: HOOK_SECRET },
    { triggerId: "g2", name: "Feed alert", secret: SECOND_SECRET },
  ],
  vaultNames: ["GITHUB_TOKEN", "NPM_TOKEN"],
  tasksCancelled: 3,
  errors: [],
  ...patch,
});

let bed: ReturnType<typeof fakeRuntime>;
let stepUp: ReturnType<typeof vi.fn>;
const onClose = vi.fn();
const writeText = vi.fn(async () => {});

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.quarantine"] = () => result();
  stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-0001"));
  onClose.mockReset();
  toasts.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  reported.mockClear();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

function Host() {
  const [open, setOpen] = useState(true);
  return open ? (
    <QuarantineDialog
      agent={{ id: "atlas-1a2b", name: "Atlas" }}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  ) : (
    <p>closed</p>
  );
}
const show = async () => {
  const page = await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <Host />
    </StepUpContext.Provider>,
  );
  await settle();
  return page;
};
const body = () => document.body.textContent ?? "";
const confirmTwice = async () => {
  await click(button(document.body, "Continue"));
  await click(button(document.body, "Quarantine Atlas"));
  await settle();
};

describe("two confirmations, then the step-up (M11R126)", () => {
  it("explains what a quarantine does and calls nothing on the first screen", async () => {
    await show();
    expect(body()).toContain("Quarantine Atlas?");
    expect(body()).toContain("pause the agent");
    expect(body()).toContain("rotate its webhook secrets");
    expect(bed.called("agents.quarantine")).toEqual([]);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it("asks a second time before anything runs", async () => {
    await show();
    await click(button(document.body, "Continue"));
    expect(body()).toContain("stays stopped until you resume it with your password");
    expect(bed.called("agents.quarantine")).toEqual([]);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it("goes through the step-up runner once, with the command id it hands out", async () => {
    await show();
    await confirmTwice();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.quarantine")).toEqual([
      expect.objectContaining({
        params: { agentId: "atlas-1a2b" },
        options: expect.objectContaining({ commandId: "step-cmd-0001" }),
      }),
    ]);
  });

  it("stays on the second screen, with no error, when the password prompt is cancelled", async () => {
    stepUp.mockResolvedValue(null);
    await show();
    await confirmTwice();
    expect(bed.called("agents.quarantine")).toEqual([]);
    expect(hasButton(document.body, "Quarantine Atlas")).toBe(true);
    expect(alerts(document.body)).toEqual([]);
  });

  it("closes on Cancel at either screen without calling anything", async () => {
    await show();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.quarantine")).toEqual([]);
  });
});

describe("the result (M11R115)", () => {
  it("shows the rotated webhook secrets once, with a copy button and a not-shown-again line", async () => {
    await show();
    await confirmTwice();
    expect(body()).toContain("Deploy hook");
    expect(body()).toContain("Feed alert");
    const values = [...document.querySelectorAll<HTMLInputElement>("input[readonly]")].map((i) => i.value);
    expect(values).toEqual([HOOK_SECRET, SECOND_SECRET]);
    expect(body()).toContain("Shown once. pap cannot show these again");
    await click(button(document.body, "Copy secret of Deploy hook"));
    expect(writeText).toHaveBeenCalledWith(HOOK_SECRET);
  });

  it("names the vault entries to rotate upstream and the tasks cancelled", async () => {
    await show();
    await confirmTwice();
    expect(body()).toContain("Rotate these where they were issued: GITHUB_TOKEN, NPM_TOKEN");
    expect(body()).toContain("Tasks cancelled: 3");
  });

  it("lists the steps that did not finish, in pap's words", async () => {
    bed.handlers["agents.quarantine"] = () =>
      result({
        errors: [
          { step: "thread", code: "timeout" },
          { step: "triggers", code: "failed" },
          { step: "tasks", code: "session_busy" },
        ],
      });
    await show();
    await confirmTwice();
    expect(body()).toContain("Closing the thread: did not finish in time");
    expect(body()).toContain("Rotating webhook secrets: failed");
    expect(body()).toContain("Cancelling tasks: The session is working.");
    expect(body()).toContain("The other steps ran");
  });

  it("says nothing about steps when all of them ran", async () => {
    await show();
    await confirmTwice();
    expect(body()).not.toContain("The other steps ran");
  });

  it("says the quarantine already ran when the answer is a replay", async () => {
    bed.handlers["agents.quarantine"] = () => {
      throw new RpcError("conflict");
    };
    await show();
    await confirmTwice();
    expect(alerts(document.body).join(" ")).toContain("already ran");
    expect(document.querySelectorAll("input[readonly]")).toHaveLength(0);
  });

  it("explains other refusals in pap's words and offers to ask again", async () => {
    bed.handlers["agents.quarantine"] = () => {
      throw new RpcError("command_failed");
    };
    await show();
    await confirmTwice();
    expect(alerts(document.body)).not.toEqual([]);
    expect(hasButton(document.body, "Quarantine Atlas")).toBe(true);
  });
});

describe("fix round 1: the call cannot be walked away from, and its answer is read", () => {
  it("keeps Cancel off while the call runs, so the secrets are still shown when it ends", async () => {
    let release: () => void = () => {};
    bed.handlers["agents.quarantine"] = () =>
      new Promise((resolve) => {
        release = () => resolve(result());
      });
    await show();
    await click(button(document.body, "Continue"));
    await click(button(document.body, "Quarantine Atlas"));
    expect(button(document.body, "Cancel").disabled).toBe(true);
    await click(button(document.body, "Cancel"));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(body()).toContain("Deploy hook");
    expect([...document.querySelectorAll<HTMLInputElement>("input[readonly]")].map((i) => i.value)).toEqual([
      HOOK_SECRET,
      SECOND_SECRET,
    ]);
  });

  it("leaves no secret in the page when the host goes away without Done", async () => {
    const page = await show();
    await confirmTwice();
    expect(body()).toContain("Deploy hook");
    await page.unmount();
    expect(document.body.innerHTML).not.toContain(HOOK_SECRET);
    expect(document.body.innerHTML).not.toContain(SECOND_SECRET);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("says the quarantine ran but its answer could not be read, not 'internal'", async () => {
    bed.handlers["agents.quarantine"] = () => ({ secrets: "nope" });
    await show();
    await confirmTwice();
    expect(alerts(document.body).join(" ")).toContain(
      "The quarantine ran, but its answer could not be read: check the agent's state",
    );
  });
});

describe("the secrets are gone after close (same rules as the secret dialog)", () => {
  it("drops them from the page and keeps them in no store, storage, URL, toast, log or report", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const page = await show();
    await confirmTwice();
    expect(body()).toContain("Deploy hook");
    const keptNowhere = () => {
      // The stores the app has, all tracked: the secrets are in none of them.
      for (const one of [
        useAgentsStore,
        useComposerPrefill,
        useInboxStore,
        useSecretDialog,
        useSessionStore,
        useShellStore,
        useTasksStore,
        useTriggerPrefill,
      ])
        expect(stores).toContain(one);
      for (const store of stores) {
        expect(JSON.stringify(store.getState())).not.toContain(HOOK_SECRET);
        expect(JSON.stringify(store.getState())).not.toContain(SECOND_SECRET);
      }
      expect(location.href + document.cookie).not.toContain(HOOK_SECRET);
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(HOOK_SECRET);
      expect(JSON.stringify(toasts.mock.calls)).not.toContain(HOOK_SECRET);
      expect(JSON.stringify(reported.mock.calls)).not.toContain(HOOK_SECRET);
      for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(HOOK_SECRET);
    };
    keptNowhere();
    await click(button(document.body, "Done"));
    keptNowhere();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page.container.textContent).toContain("closed");
    expect(document.body.innerHTML).not.toContain(HOOK_SECRET);
    expect(document.body.innerHTML).not.toContain(SECOND_SECRET);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("is written in French too", async () => {
    setLocale("fr");
    await show();
    expect(body()).toContain("Mettre Atlas en quarantaine");
  });
});
