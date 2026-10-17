// @vitest-environment happy-dom
import { act } from "react";
import type { AnyRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, click, settle, text, type Mounted } from "../../testing/dom.ts";
import { manualTimers } from "../../testing/push-env.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import {
  EMPTY_WORKSPACE,
  itemOf,
  loadInbox,
  mountLanding,
  useWorkspaceStore,
} from "../../testing/landing-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ID = "abcdefghijklmnopqrstuv";
let bed: ReturnType<typeof fakeRuntime>;
let clock: ReturnType<typeof manualTimers>;
let mounted: Mounted | null = null;
let router: AnyRouter;

async function open(segment = ID) {
  clock = manualTimers();
  const landing = await mountLanding(segment, clock.timers);
  mounted = landing.mounted;
  router = landing.router;
  await settle();
  return mounted.container;
}
const answer = (target: unknown) => (bed.handlers["push.open"] = () => ({ target }));
const pathname = () => router.state.location.pathname;

beforeEach(() => {
  setLocale("fr");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useShellStore.getState().reset();
  useInboxStore.getState().reset();
  useInboxReveal.getState().clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  useShellStore.getState().apply(shellSnapshot([shellSession({ id: "s1", needsInput: true })]));
  loadInbox([itemOf({ id: "q1" })]);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  setLocale("en");
});

describe("Landing", () => {
  it("shows a skeleton, calls push.open once with the id, and replaces the entry with the session", async () => {
    let release: (value: unknown) => void = () => {};
    bed.handlers["push.open"] = () => new Promise((resolve) => (release = resolve));
    const page = await open();
    expect(page.querySelector("[data-landing-skeleton]")).not.toBeNull();
    expect(bed.called("push.open").map((call) => call.params)).toEqual([{ id: ID }]);
    expect(pathname()).toBe(`/n/${ID}`);
    release({ target: { kind: "session", id: "s1" } });
    await settle();
    expect(pathname()).toBe("/s/s1");
    expect(router.history.length).toBe(1);
    expect(bed.called("push.open")).toHaveLength(1);
  });

  it("opens the agent thread and the two settings sections", async () => {
    answer({ kind: "agent", id: "helper-1a2b" });
    await open();
    expect(pathname()).toBe("/agents/helper-1a2b");
    await mounted?.unmount();
    answer({ kind: "settings", id: "automation" });
    await open();
    expect(pathname()).toBe("/settings/automation");
    await mounted?.unmount();
    answer({ kind: "settings", id: "notifications" });
    await open();
    expect(pathname()).toBe("/settings/notifications");
  });

  it("opens the Inbox on the item: back to the open tab, and the shell is asked to reveal the row", async () => {
    answer({ kind: "inbox", id: "q1" });
    await open();
    expect(pathname()).toBe("/");
    expect(useInboxReveal.getState()).toMatchObject({ open: true, itemId: "q1" });
  });

  it("goes back to the active tab when the Inbox opens", async () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    answer({ kind: "inbox", id: null });
    await open();
    expect(pathname()).toBe("/s/s1");
    expect(useInboxReveal.getState()).toMatchObject({ open: true, itemId: null });
  });

  it("makes no call for an id that is not a push id, and says the notification no longer exists", async () => {
    for (const segment of [
      "short",
      `${ID}x`,
      "abcdefghijklmnopqrst!v",
      "..%2F..%2Fx",
      "https%3A%2F%2Fevil.example",
    ]) {
      const page = await open(segment);
      expect(text(page), segment).toContain("Cette notification n'existe plus");
      await mounted?.unmount();
    }
    expect(bed.called("push.open")).toEqual([]);
  });

  it("says the notification no longer exists on not_found, with a way home", async () => {
    bed.handlers["push.open"] = () => {
      throw new RpcError("not_found");
    };
    const page = await open();
    expect(text(page)).toContain("Cette notification n'existe plus");
    await click(button(page, "Retour à l'accueil"));
    await settle();
    expect(pathname()).toBe("/");
  });

  it("says Déjà traité for a closed question, with a button to the Inbox", async () => {
    loadInbox([itemOf({ id: "q1", resolvedAt: 5, resolution: "answered" })]);
    answer({ kind: "inbox", id: "q1" });
    const page = await open();
    expect(text(page)).toContain("Déjà traité");
    expect(pathname()).toBe(`/n/${ID}`);
    await click(button(page, "Ouvrir la boîte de réception"));
    await settle();
    expect(pathname()).toBe("/");
    expect(useInboxReveal.getState().open).toBe(true);
  });

  it("says Déjà traité for a session that no longer waits", async () => {
    useShellStore.getState().reset();
    useShellStore.getState().apply(shellSnapshot([shellSession({ id: "s1", needsInput: false })]));
    answer({ kind: "session", id: "s1" });
    const page = await open();
    expect(text(page)).toContain("Déjà traité");
    expect(pathname()).toBe(`/n/${ID}`);
  });

  it("moves focus to the notice heading when a notice replaces the skeleton (a status region that is gone says nothing)", async () => {
    const focused = () => document.activeElement?.textContent ?? "";
    bed.handlers["push.open"] = () => {
      throw new RpcError("not_found");
    };
    await open();
    expect(focused()).toBe("Cette notification n'existe plus");
    await mounted?.unmount();
    bed.handlers["push.open"] = () => {
      throw new RpcError("push_unavailable");
    };
    await open();
    expect(focused()).toBe("La notification n'a pas pu être ouverte");
    await mounted?.unmount();
    loadInbox([itemOf({ id: "q1", resolvedAt: 5, resolution: "answered" })]);
    answer({ kind: "inbox", id: "q1" });
    await open();
    expect(focused()).toBe("Déjà traité");
  });

  it("never shows anything the daemon sent beyond the target", async () => {
    bed.handlers["push.open"] = () => ({
      target: { kind: "inbox", id: "q1" },
      body: "rm -rf /",
      title: "secret",
    });
    const page = await open();
    expect(text(page)).not.toContain("rm -rf");
  });

  it("refuses a target the router cannot take as data, as not found", async () => {
    answer({ kind: "session", id: "a/b" });
    const page = await open();
    expect(text(page)).toContain("Cette notification n'existe plus");
    expect(pathname()).toBe(`/n/${ID}`);
  });

  it("waits for the stream it needs, and opens anyway when the stream never comes", async () => {
    useShellStore.getState().reset();
    answer({ kind: "session", id: "s1" });
    const page = await open();
    expect(page.querySelector("[data-landing-skeleton]")).not.toBeNull();
    expect(pathname()).toBe(`/n/${ID}`);
    expect(clock.pending()).toEqual([5_000]);
    await act(async () => {
      clock.fireNext();
    });
    await settle();
    expect(pathname()).toBe("/s/s1");
  });

  it("opens by itself once the stream it waited for says the question still waits", async () => {
    useShellStore.getState().reset();
    answer({ kind: "session", id: "s1" });
    await open();
    useShellStore.getState().apply(shellSnapshot([shellSession({ id: "s1", needsInput: true })]));
    await settle();
    expect(pathname()).toBe("/s/s1");
    expect(clock.pending()).toEqual([]);
  });

  it("offers a retry when the daemon cannot answer, and asks again", async () => {
    bed.handlers["push.open"] = () => {
      throw new RpcError("push_unavailable");
    };
    const page = await open();
    expect(text(page)).toContain("La notification n'a pas pu être ouverte");
    answer({ kind: "agent", id: "helper-1a2b" });
    await click(button(page, "Réessayer"));
    await settle();
    expect(bed.called("push.open")).toHaveLength(2);
    expect(pathname()).toBe("/agents/helper-1a2b");
  });

  it("speaks English with the English locale", async () => {
    setLocale("en");
    bed.handlers["push.open"] = () => {
      throw new RpcError("not_found");
    };
    const page = await open();
    expect(text(page)).toContain("This notification no longer exists");
  });
});
