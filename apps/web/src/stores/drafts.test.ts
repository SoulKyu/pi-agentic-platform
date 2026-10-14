// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionDrafts,
  deviceStorage,
  loadDraft,
  loadPending,
  MAX_DRAFT_CHARS,
  mergeRestored,
  saveDraft,
  savePending,
} from "./drafts.ts";

beforeEach(() => localStorage.clear());

const fullStorage = {
  getItem: () => null,
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {},
} as unknown as Storage;
const pendingOf = (patch: object = {}) => ({
  params: { sessionId: "s1", text: "deploy", streamingBehavior: "steer" as const },
  commandId: "c-1",
  ...patch,
});

describe("drafts", () => {
  it("keeps one draft per session, removes an empty one and caps its size", () => {
    saveDraft(localStorage, "s1", "hello");
    saveDraft(localStorage, "s2", "other");
    expect(loadDraft(localStorage, "s1")).toBe("hello");
    saveDraft(localStorage, "s1", "");
    expect(localStorage.getItem("pap.draft.s1")).toBeNull();
    saveDraft(localStorage, "s1", "x".repeat(MAX_DRAFT_CHARS + 10));
    expect(loadDraft(localStorage, "s1")).toHaveLength(MAX_DRAFT_CHARS);
    localStorage.setItem("pap.draft.s3", "y".repeat(MAX_DRAFT_CHARS + 10));
    expect(loadDraft(localStorage, "s3")).toHaveLength(MAX_DRAFT_CHARS);
  });

  it("keeps working when storage refuses, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveDraft(fullStorage, "s1", "a");
    saveDraft(fullStorage, "s1", "b");
    savePending(fullStorage, "s1", pendingOf());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("reads nothing, without throwing, from storage that cannot be read or is missing", () => {
    const unreadable = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    expect(loadDraft(unreadable, "s1")).toBe("");
    expect(loadDraft(null, "s1")).toBe("");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadPending(unreadable, "s1")).toBeNull();
    expect(loadPending(null, "s1")).toBeNull();
    warn.mockRestore();
  });

  it("gives no storage when the browser denies access to it", () => {
    const denied = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(deviceStorage()).toBeNull();
    denied.mockRestore();
    warn.mockRestore();
    expect(deviceStorage()).toBe(localStorage);
  });

  it("puts restored text before what is being typed", () => {
    expect(mergeRestored("sent", "")).toBe("sent");
    expect(mergeRestored("", "typing")).toBe("typing");
    expect(mergeRestored("sent", "typing")).toBe("sent\n\ntyping");
  });

  it("keeps a pending send, refuses a malformed one, and forgets everything at sign-out (owner R2-4)", () => {
    const pending = pendingOf();
    savePending(localStorage, "s1", pending);
    expect(loadPending(localStorage, "s1")).toEqual(pending);
    localStorage.setItem("pap.pending.s2", "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadPending(localStorage, "s2")).toBeNull();
    warn.mockRestore();
    expect(localStorage.getItem("pap.pending.s2")).toBeNull();
    saveDraft(localStorage, "s1", "draft");
    localStorage.setItem("pap.sessions.streaming", "followUp");
    clearSessionDrafts(localStorage);
    expect([
      localStorage.getItem("pap.draft.s1"),
      localStorage.getItem("pap.pending.s1"),
      localStorage.getItem("pap.sessions.streaming"),
    ]).toEqual([null, null, "followUp"]);
  });

  it("drops a pending send of the wrong shape, or for another session, and removes it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad: unknown[] = [
      null,
      "text",
      42,
      {},
      pendingOf({ commandId: 7 }),
      pendingOf({ commandId: "" }),
      pendingOf({ params: { sessionId: "other", text: "x", streamingBehavior: "steer" } }),
      pendingOf({ params: { sessionId: "s1", text: 5, streamingBehavior: "steer" } }),
      pendingOf({ params: { sessionId: "s1", text: "x", streamingBehavior: "shout" } }),
      pendingOf({ params: null }),
    ];
    for (const value of bad) {
      localStorage.setItem("pap.pending.s1", JSON.stringify(value));
      expect(loadPending(localStorage, "s1"), JSON.stringify(value)).toBeNull();
      expect(localStorage.getItem("pap.pending.s1")).toBeNull();
    }
    warn.mockRestore();
  });

  it("caps the text of a pending send at the draft cap, and its command id", () => {
    const long = pendingOf({
      params: { sessionId: "s1", text: "z".repeat(MAX_DRAFT_CHARS + 5), streamingBehavior: "followUp" },
      commandId: "c".repeat(500),
    });
    localStorage.setItem("pap.pending.s1", JSON.stringify(long));
    const loaded = loadPending(localStorage, "s1");
    expect(loaded?.params.text).toHaveLength(MAX_DRAFT_CHARS);
    expect(loaded?.commandId).toHaveLength(128);
  });

  it("clears what it can when storage fails half way, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      length: 1,
      key: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;
    clearSessionDrafts(broken);
    clearSessionDrafts(null);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("a pending send with attachments (M8R114)", () => {
  const ids = ["a".repeat(22), "B_-".padEnd(22, "c")];

  it("round-trips its attachment ids", () => {
    const pending = pendingOf();
    const withIds = { ...pending, params: { ...pending.params, attachments: ids } };
    savePending(localStorage, "s1", withIds);
    expect(loadPending(localStorage, "s1")).toEqual(withIds);
  });

  it("forgets the attachment ids at sign-out with the rest of the pending send", () => {
    const pending = pendingOf();
    savePending(localStorage, "s1", { ...pending, params: { ...pending.params, attachments: ids } });
    clearSessionDrafts(localStorage);
    expect(loadPending(localStorage, "s1")).toBeNull();
  });

  it("drops the whole entry when one id is not 22 URL-safe characters, or there are too many", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = pendingOf();
    for (const attachments of [[ids[0], "x".repeat(21)], "nope", Array.from({ length: 11 }, () => ids[0])]) {
      localStorage.setItem(
        "pap.pending.s1",
        JSON.stringify({ ...pending, params: { ...pending.params, attachments } }),
      );
      expect(loadPending(localStorage, "s1"), JSON.stringify(attachments)).toBeNull();
      expect(localStorage.getItem("pap.pending.s1")).toBeNull();
    }
    warn.mockRestore();
  });
});
