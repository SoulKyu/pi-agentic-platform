import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootWorker, client, freshCaches, ID, ORIGIN, SHELL, stubNetwork, type Worker } from "./harness.ts";

let worker: Worker;
beforeEach(() => {
  freshCaches();
  stubNetwork();
  worker = bootWorker("b1", SHELL);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ICONS = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" };
const push = (raw: string | null) => worker.fire("push", { data: raw === null ? null : { text: () => raw } });
const wire = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    id: ID,
    cls: "approval",
    title: "pap",
    body: "Une demande attend votre réponse.",
    ts: 1,
    ...over,
  });

describe("push.shows-notification", () => {
  it("shows the payload with the id as tag and data", async () => {
    const fired = push(wire());
    await fired.done();
    expect(worker.shown).toEqual([
      {
        title: "pap",
        options: { ...ICONS, body: "Une demande attend votre réponse.", tag: ID, data: { id: ID } },
      },
    ]);
  });

  it("cuts a long title to 80 code points and a long body to 200", async () => {
    await push(wire({ title: "x".repeat(1000), body: "y".repeat(500) })).done();
    expect(worker.shown[0]?.title).toHaveLength(80);
    expect((worker.shown[0]?.options.body as string).length).toBe(200);
  });

  it("holds the event open until showNotification settles", async () => {
    let release: () => void = () => undefined;
    worker.scope.registration.showNotification.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const fired = push(wire());
    expect(fired.waits).toHaveLength(1);
    const settled = vi.fn();
    void fired.waits[0]?.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    release();
    await fired.done();
    expect(settled).toHaveBeenCalled();
  });
});

describe("push.malformed.shows-generic", () => {
  it.each([
    ["invalid JSON", "{not json"],
    ["wrong version", wire({ v: 2 })],
    ["bad id", wire({ id: "short" })],
    ["id with a slash", wire({ id: "AbCdEfGhIjKl/nOpQrStUv" })],
    ["id with dots", wire({ id: ".".repeat(22) })],
    ["numeric id", wire({ id: 1234567890123456 })],
    ["unknown class", wire({ cls: "hack" })],
    ["5 KB body", wire({ body: "z".repeat(5000) })],
    ["JSON null", "null"],
    ["no data at all", null],
  ])("%s still shows exactly one generic notification", async (_name, raw) => {
    const fired = push(raw);
    await fired.done();
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe("pap");
    expect(worker.shown[0]?.options).toEqual({ ...ICONS, body: "", data: { id: null } });
    expect(worker.shown[0]?.options).not.toHaveProperty("tag");
  });
});

describe("click.opens-only-same-origin-by-id", () => {
  const click = (data: unknown) => {
    const close = vi.fn();
    const fired = worker.fire("notificationclick", { notification: { close, data } });
    return { close, fired };
  };

  it("focuses an open same-origin window and asks it to open /n/<id>", async () => {
    const foreign = client("https://evil.example/x");
    const mine = client(`${ORIGIN}/sessions`);
    worker.windows.push(foreign, mine);
    const { close, fired } = click({ id: ID });
    await fired.done();
    expect(close).toHaveBeenCalled();
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.postMessage).toHaveBeenCalledWith({ type: "open", path: `/n/${ID}` });
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(foreign.postMessage).not.toHaveBeenCalled();
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a window at <origin>/n/<id> when none is open", async () => {
    worker.windows.push(client("https://evil.example/x"));
    await click({ id: ID }).fired.done();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/n/${ID}`);
  });

  it.each([
    ["absolute url", "https://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["traversal", "/../x"],
    ["javascript", "javascript:alert(1)"],
    ["number", 42],
    ["null", null],
  ])("data.id = %s opens / and nothing else", async (_name, id) => {
    await click({ id }).fired.done();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("with no data at all opens /", async () => {
    await click(null).fired.done();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it("ignores a url field in the notification data", async () => {
    await click({ id: ID, url: "https://evil.example/steal" }).fired.done();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/n/${ID}`);
  });

  it("prefers a window on an SPA path over one sitting on an API path", async () => {
    const api = client(`${ORIGIN}/auth/passkeys`);
    const app = client(`${ORIGIN}/sessions`);
    worker.windows.push(api, app);
    await click({ id: ID }).fired.done();
    expect(app.focus).toHaveBeenCalled();
    expect(api.focus).not.toHaveBeenCalled();
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it("opens a window when the only same-origin window is on an API path", async () => {
    const api = client(`${ORIGIN}/files/x`);
    worker.windows.push(api);
    await click({ id: ID }).fired.done();
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/n/${ID}`);
  });

  it("falls back to openWindow when focus() rejects", async () => {
    const stale = client(`${ORIGIN}/sessions`);
    stale.focus.mockImplementation(() => Promise.reject(new Error("gone")));
    worker.windows.push(stale);
    await click({ id: ID }).fired.done();
    expect(stale.postMessage).not.toHaveBeenCalled();
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/n/${ID}`);
  });

  it("an existing window only ever gets the safe path", async () => {
    const mine = client(`${ORIGIN}/`);
    worker.windows.push(mine);
    await click({ id: "//evil.example" }).fired.done();
    expect(mine.postMessage).toHaveBeenCalledWith({ type: "open", path: "/" });
  });
});

describe("pushsubscriptionchange", () => {
  it("asks the open windows to re-subscribe and holds no credential", async () => {
    const mine = client(`${ORIGIN}/`);
    worker.windows.push(mine);
    await worker.fire("pushsubscriptionchange").done();
    expect(mine.postMessage).toHaveBeenCalledWith({ type: "resubscribe" });
  });
});
