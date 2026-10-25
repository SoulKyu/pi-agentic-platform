// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SecretsList } from "./SecretsList.tsx";

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

const SECRET = "ghp_Zx9-never-stored-4711";
const SAVED = Date.UTC(2026, 9, 15, 12, 0, 0);
let bed: ReturnType<typeof fakeRuntime>;
let entries: Array<{ name: string; updatedAt: number }>;
let state: "ok" | "unreadable";

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  entries = [{ name: "GITHUB_TOKEN", updatedAt: SAVED }];
  state = "ok";
  bed.handlers["secrets.list"] = () => ({ entries: [...entries], state });
  bed.handlers["secrets.set"] = (params) => {
    const { name } = params as { name: string };
    entries = [...entries.filter((entry) => entry.name !== name), { name, updatedAt: SAVED + 1 }];
    return {};
  };
  bed.handlers["secrets.delete"] = (params) => {
    const { name } = params as { name: string };
    entries = entries.filter((entry) => entry.name !== name);
    return {};
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  reported.mockClear();
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

const show = async () => {
  const page = await mount(<SecretsList agentId="atlas-1a2b" />);
  await settle();
  return page;
};
const secretField = () => document.querySelector<HTMLInputElement>('input[type="password"]');
const add = async (page: Awaited<ReturnType<typeof show>>, name: string, value: string) => {
  await typeInto(field(page.container, "Name"), name);
  const input = secretField();
  if (input === null) throw new Error("no masked field");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  await click(button(page.container, "Add secret"));
  await settle();
};

describe("the list (M11R126, M11R85)", () => {
  it("shows names and the date each was saved, never a value", async () => {
    const page = await show();
    expect(bed.called("secrets.list")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
    expect(text(page.container)).toContain("GITHUB_TOKEN");
    expect(text(page.container)).toContain("2026");
  });

  it("says when there is none", async () => {
    entries = [];
    expect(text((await show()).container)).toContain(
      "No secret saved yet. A saved secret reaches the agent's shell as an environment variable.",
    );
  });

  it("shows a fixed sentence and no entry while the vault cannot be read", async () => {
    state = "unreadable";
    const page = await show();
    expect(text(page.container)).toContain("The vault cannot be read");
    const failure = page.container.querySelector('[data-slot="inline-error"]');
    expect(failure?.getAttribute("role")).toBe("status");
    expect(failure?.className).toContain("text-err");
    expect(text(page.container)).not.toContain("GITHUB_TOKEN");
    expect(secretField()).toBeNull();
  });

  it("says the read failed in pap's words", async () => {
    bed.handlers["secrets.list"] = () => {
      throw new RpcError("internal");
    };
    expect(
      (await show()).container.querySelector('[data-slot="inline-error"][role="status"]'),
    ).not.toBeNull();
  });
});

describe("the copy says what the vault protects and what it does not (RT-13)", () => {
  it("holds the values, environment and redaction lines", async () => {
    const words = text((await show()).container);
    expect(words).toContain("Values are never shown again");
    expect(words).toContain("environment variables");
    expect(words).toContain("[SECRET:NAME]");
    expect(words).toContain("at most 50 names");
  });

  it("holds both 'not against' lines, the backup one naming the key beside the vault", async () => {
    const words = text((await show()).container);
    expect(words).toContain("Not against: a process of yours that can read both the vault and its key file.");
    expect(words).toContain("Not against: a backup of the whole $PAP_HOME");
    expect(words).toContain("The key sits beside the vault");
  });

  it("never claims protection for backups", async () => {
    const words = text((await show()).container);
    expect(words).not.toMatch(/protects?( against)?:? [^.]*backup/i);
    expect(words).toContain("Encryption protects against: a copy of a vault file without its key file");
  });

  it("is in French too", async () => {
    setLocale("fr");
    const words = text((await show()).container);
    expect(words).toContain("Pas contre\u202f: une sauvegarde de tout $PAP_HOME");
  });
});

describe("adding a secret", () => {
  it("has a masked field that the browser neither completes nor spell-checks", async () => {
    await show();
    const input = secretField();
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");
    expect(input?.getAttribute("name")).toBeNull();
  });

  it("sends the name and the value once, empties the field and lists the new name", async () => {
    const page = await show();
    await add(page, "NPM_TOKEN", SECRET);
    expect(bed.called("secrets.set")).toEqual([
      expect.objectContaining({
        params: { agentId: "atlas-1a2b", name: "NPM_TOKEN", value: SECRET },
        options: expect.objectContaining({ commandId: expect.any(String) }),
      }),
    ]);
    expect(secretField()?.value).toBe("");
    expect(text(page.container)).toContain("NPM_TOKEN");
    expect(text(page.container)).not.toContain(SECRET);
  });

  it("keeps the value in no store, storage, URL, DOM text, log or report", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const page = await show();
    await add(page, "NPM_TOKEN", SECRET);
    useAgentsStore.getState().reset();
    // The stores the app has, read through their getters: the secret is in none of them.
    expect(
      [
        useAgentsStore,
        useComposerPrefill,
        useInboxStore,
        useSecretDialog,
        useSessionStore,
        useShellStore,
        useTasksStore,
        useTriggerPrefill,
      ].every((one) => stores.some((tracked) => tracked === (one as unknown))),
    ).toBe(true);
    expect(stores.length).toBeGreaterThanOrEqual(8);
    for (const store of stores) expect(JSON.stringify(store.getState())).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(location.href).not.toContain(SECRET);
    expect(document.cookie).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(secretField()?.value).toBe("");
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(reported.mock.calls)).not.toContain(SECRET);
    for (const entry of bed.calls.filter((call) => call.method !== "secrets.set")) {
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    }
  });

  it("empties the field when the call fails, and says why", async () => {
    bed.handlers["secrets.set"] = () => {
      throw new RpcError("limit_reached");
    };
    const page = await show();
    await add(page, "NPM_TOKEN", SECRET);
    expect(secretField()?.value).toBe("");
    expect(alerts(page.container)).not.toEqual([]);
    expect(text(page.container)).not.toContain(SECRET);
  });

  it("refuses a name that is not an environment name, before any call", async () => {
    const page = await show();
    await add(page, "npm token", SECRET);
    expect(bed.called("secrets.set")).toEqual([]);
    expect(text(page.container)).toContain("capital letters");
  });

  it("keeps Add off until both a name and a value are there", async () => {
    const page = await show();
    expect(button(page.container, "Add secret").disabled).toBe(true);
    await typeInto(field(page.container, "Name"), "NPM_TOKEN");
    expect(button(page.container, "Add secret").disabled).toBe(true);
  });
});

describe("deleting a secret", () => {
  it("asks once, then deletes by name", async () => {
    const page = await show();
    await click(button(page.container, "Delete GITHUB_TOKEN"));
    expect(bed.called("secrets.delete")).toEqual([]);
    expect(text(page.container)).toContain("Delete GITHUB_TOKEN from this agent's vault?");
    await click(button(page.container, "Delete"));
    await settle();
    expect(bed.called("secrets.delete")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b", name: "GITHUB_TOKEN" } }),
    ]);
    expect(page.container.querySelector("li")).toBeNull();
    expect(text(page.container)).toContain(
      "No secret saved yet. A saved secret reaches the agent's shell as an environment variable.",
    );
  });

  it("does nothing when the question is cancelled", async () => {
    const page = await show();
    await click(button(page.container, "Delete GITHUB_TOKEN"));
    await click(button(page.container, "Keep"));
    expect(bed.called("secrets.delete")).toEqual([]);
    expect(hasButton(page.container, "Delete GITHUB_TOKEN")).toBe(true);
  });
});
