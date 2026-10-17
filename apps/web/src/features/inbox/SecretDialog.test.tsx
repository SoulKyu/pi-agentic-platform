// @vitest-environment happy-dom
import { DEFAULT_SESSION_POLICY_VIEW, type AgentRequestView, type AgentSummary } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { current, newBed, show } from "./inbox-bed.tsx";
import SecretDialog from "./SecretDialog.tsx";

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
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const NOW = Date.now();
const atlas: AgentSummary = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};
const request: AgentRequestView = {
  id: "r2",
  agentId: "atlas-1a2b",
  kind: "secret",
  title: "GITHUB_TOKEN",
  detail: "to push the branch\u202e <b>now</b>",
  createdAt: NOW,
  expiresAt: NOW + 10 * 60_000,
};
const SECRET = "ghp_Zx9-never-stored-4711";

const setTaint = (tainted: boolean | null) =>
  useSessionStore.setState({
    views:
      tainted === null
        ? {}
        : {
            s1: {
              ...EMPTY_VIEW,
              loaded: true,
              policy: { ...DEFAULT_SESSION_POLICY_VIEW, tainted },
            },
          },
  });

/** A snapshot of the thread arriving now: a view of a later generation than any held at mount. */
const arrives = (tainted: boolean, id = "s1") =>
  act(async () => {
    const held = useSessionStore.getState().views[id]?.generation ?? 0;
    useSessionStore.setState({
      views: {
        ...useSessionStore.getState().views,
        [id]: {
          ...EMPTY_VIEW,
          loaded: true,
          generation: held + 1,
          policy: { ...DEFAULT_SESSION_POLICY_VIEW, tainted },
        },
      },
    });
  });

let bed: ReturnType<typeof newBed>;
beforeEach(() => {
  bed = newBed();
  useAgentsStore.getState().reset();
  useAgentsStore
    .getState()
    .apply({ kind: "snapshot", agents: [atlas], requests: [request], truncated: false });
  setTaint(false);
  useSecretDialog.getState().open("r2");
});
afterEach(() => {
  vi.restoreAllMocks();
  reported.mockClear();
  useSecretDialog.getState().close();
  useAgentsStore.getState().reset();
  setTaint(null);
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

const open = () => show(<SecretDialog />);
const input = () => document.querySelector<HTMLInputElement>('input[type="password"]');
const body = () => document.body.textContent ?? "";

describe("the dialog's content", () => {
  it("names the agent and the secret, and shows the reason as stripped untrusted text", async () => {
    await open();
    expect(body()).toContain("Atlas asks for a secret");
    expect(body()).toContain("GITHUB_TOKEN");
    expect(body()).toContain("to push the branch <b>now</b>");
    expect(body()).not.toContain("\u202e");
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("[data-untrusted]")).not.toBeNull();
  });

  it("has a masked field that the browser neither completes nor spell-checks", async () => {
    await open();
    const field = input();
    expect(field).not.toBeNull();
    expect(field?.getAttribute("autocomplete")).toBe("off");
    expect(field?.getAttribute("spellcheck")).toBe("false");
    expect(field?.hasAttribute("name")).toBe(false);
  });

  it("starts on Use once, with one line for each mode", async () => {
    await open();
    const once = document.querySelector<HTMLInputElement>('input[type="radio"][value="once"]');
    const vault = document.querySelector<HTMLInputElement>('input[type="radio"][value="vault"]');
    expect(once?.checked).toBe(true);
    expect(vault?.checked).toBe(false);
    expect(body()).toContain("Use once");
    expect(body()).toContain("Save in Atlas's vault");
    expect(body()).toContain("pap forgets it");
    expect(body()).toContain("encrypted");
  });

  it("warns when a fresh snapshot says the asking thread has read external content (M11R107, W5-R38)", async () => {
    setTaint(null);
    await open();
    await arrives(true);
    expect(body()).toContain("read external content");
    expect(document.querySelector('[data-slot="chip"]')?.textContent).toBe("external content");
  });

  it("says nothing of the sort when a fresh snapshot says the thread is clean, and 'checking' before it", async () => {
    setTaint(null);
    await open();
    expect(body()).toContain("Checking");
    await arrives(false);
    expect(document.querySelector('[data-slot="chip"]')).toBeNull();
    expect(body()).not.toContain("provide a secret only");
    expect(body()).not.toContain("Checking");
  });

  it("does not trust a held untainted view: it checks, then warns when the fresh snapshot is tainted (C1)", async () => {
    await open();
    expect(body()).toContain("Checking");
    expect(document.querySelector('[data-slot="chip"]')).toBeNull();
    expect(body()).not.toContain("provide a secret only");
    await arrives(true);
    expect(body()).toContain("read external content");
    expect(body()).not.toContain("Checking");
  });

  it("keeps checking when the snapshot that arrives cannot be read, instead of showing the old taint (I1)", async () => {
    await open();
    await act(async () => {
      useSessionStore.setState({
        views: {
          s1: { ...EMPTY_VIEW, loaded: true, unreadable: true, generation: 1 },
        },
      });
    });
    expect(body()).toContain("Checking");
    expect(document.querySelector('[data-slot="chip"]')).toBeNull();
  });

  it("checks again when the thread changes under the open dialog, until the new session's own snapshot (C1)", async () => {
    setTaint(null);
    await open();
    await arrives(true);
    expect(body()).toContain("provide a secret only");
    await act(async () => {
      useAgentsStore.getState().apply({ kind: "agent", agent: { ...atlas, threadSessionId: "s2" } });
    });
    expect(body()).toContain("Checking");
    expect(body()).not.toContain("provide a secret only");
    await arrives(false, "s2");
    expect(body()).not.toContain("Checking");
    expect(document.querySelector('[data-slot="chip"]')).toBeNull();
  });

  it("keeps checking with a held view when the connection is closed, so no snapshot can come (C1)", async () => {
    const closed = fakeRuntime("idle");
    current.runtime = closed.runtime;
    await open();
    expect(body()).toContain("Checking");
    expect(document.querySelector('[data-slot="chip"]')).toBeNull();
    expect(body()).not.toContain("provide a secret only");
  });

  it("subscribes to the thread's session while open, for its current taint, and no other", async () => {
    setTaint(null);
    await open();
    expect(bed.called("subscribe.session").map((call) => call.params)).toEqual([{ sessionId: "s1" }]);
  });

  it("asks for a fresh snapshot when it already holds a view of the thread, which may be stale", async () => {
    await open();
    expect(bed.called("subscribe.session").length).toBeGreaterThan(1);
  });

  it("does not read a view that has not loaded yet as untainted", async () => {
    useSessionStore.setState({ views: { s1: EMPTY_VIEW } });
    await open();
    expect(document.body.textContent).toContain("Checking");
  });

  it("reads in French", async () => {
    setLocale("fr");
    await open();
    expect(body()).toContain("Atlas demande un secret");
  });

  it("says the request is no longer open, with no field, when it was answered elsewhere", async () => {
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    await act(async () => {
      useAgentsStore.getState().apply({ kind: "request_closed", id: "r2" });
    });
    expect(input()).toBeNull();
    expect(body()).toContain("no longer open");
  });
});

describe("Provide", () => {
  it("keeps Provide off until something is typed", async () => {
    await open();
    expect(button(document.body, "Provide").disabled).toBe(true);
    await typeInto(input() as HTMLInputElement, "x");
    expect(button(document.body, "Provide").disabled).toBe(false);
  });

  it("sends the value once, with the mode and a commandId, then closes with the field gone", async () => {
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    await click(button(document.body, "Provide"));
    await settle();
    const [call] = bed.called("secrets.answerRequest");
    expect(call?.params).toEqual({ requestId: "r2", value: SECRET, mode: "once" });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(bed.called("secrets.answerRequest")).toHaveLength(1);
    expect(useSecretDialog.getState().requestId).toBeNull();
    expect(input()).toBeNull();
  });

  it("sends the vault mode when it is picked", async () => {
    await open();
    await click(document.querySelector('input[type="radio"][value="vault"]') as HTMLInputElement);
    await typeInto(input() as HTMLInputElement, SECRET);
    await click(button(document.body, "Provide"));
    await settle();
    expect(bed.called("secrets.answerRequest")[0]?.params).toEqual({
      requestId: "r2",
      value: SECRET,
      mode: "vault",
    });
  });

  it("clears the field when the call fails, and says why, in words", async () => {
    bed.handlers["secrets.answerRequest"] = () => {
      throw new RpcError("limit_reached");
    };
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    await click(button(document.body, "Provide"));
    await settle();
    expect(input()?.value).toBe("");
    expect(document.querySelector('[role="alert"]')?.textContent).not.toBe("");
    expect(useSecretDialog.getState().requestId).toBe("r2");
    expect(button(document.body, "Provide").disabled).toBe(true);
  });
});

describe("the value is kept nowhere (MC30)", () => {
  it("is in no zustand store, no storage, no URL, no toast and no other call, before or after Provide", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    await click(button(document.body, "Provide"));
    await settle();
    // Nothing was written to a console or reported as a client issue.
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SECRET);
    expect(JSON.stringify(reported.mock.calls)).not.toContain(SECRET);
    // The stores this file loads, so the check cannot pass over an empty list.
    expect(stores.length).toBeGreaterThanOrEqual(8);
    expect(stores).toEqual(
      expect.arrayContaining([
        useInboxStore,
        useShellStore,
        useTasksStore,
        useComposerPrefill,
        useTriggerPrefill,
      ]),
    );
    for (const store of stores) expect(JSON.stringify(store.getState())).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(location.href).not.toContain(SECRET);
    expect(document.cookie).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    const others = bed.calls.filter((call) => call.method !== "secrets.answerRequest");
    expect(JSON.stringify(others)).not.toContain(SECRET);
    expect(JSON.stringify(bed.calls.map((call) => call.options))).not.toContain(SECRET);
  });

  it("is not in any store while it is being typed either", async () => {
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    for (const store of stores) expect(JSON.stringify(store.getState())).not.toContain(SECRET);
  });
});

describe("Decline, close and sign-out", () => {
  it("declines through secrets.declineRequest, closes, and sends no value", async () => {
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    await click(button(document.body, "Decline"));
    await settle();
    expect(bed.called("secrets.declineRequest")).toEqual([
      expect.objectContaining({ params: { requestId: "r2" } }),
    ]);
    expect(bed.called("secrets.answerRequest")).toEqual([]);
    expect(useSecretDialog.getState().requestId).toBeNull();
  });

  it("clears the field when the dialog is closed", async () => {
    const page = await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    const field = input() as HTMLInputElement;
    await click(button(document.body, "Close"));
    expect(useSecretDialog.getState().requestId).toBeNull();
    expect(field.value).toBe("");
    await page.unmount();
  });

  it("closes and clears when the sign-out reset closes the store", async () => {
    await open();
    await typeInto(input() as HTMLInputElement, SECRET);
    const field = input() as HTMLInputElement;
    await act(async () => {
      useSecretDialog.getState().close();
    });
    expect(field.value).toBe("");
    expect(useSecretDialog.getState().requestId).toBeNull();
  });
});
