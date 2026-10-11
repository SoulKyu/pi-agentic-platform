import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogResponse,
  EMPTY_QUEUE,
  NO_HISTORY,
  Notice,
  Panel,
  StatusEntry,
  UI_LIMITS,
} from "./index.ts";

const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  category: "exec",
};

describe("session stream v2 schemas (additive)", () => {
  it("opens an approval with distinct answers only", () => {
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "session", "always", "once"] }).success).toBe(
      true,
    );
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "deny"] }).success).toBe(false);
    expect(Dialog.safeParse({ ...approval, answers: ["deny"] }).success).toBe(false);
  });

  it("answers an approval with one of four answers", () => {
    expect(DialogResponse.safeParse({ answer: "always" }).success).toBe(true);
    expect(DialogResponse.safeParse({ answer: "forever" }).success).toBe(false);
  });

  it("bounds what extensions put on screen", () => {
    expect(StatusEntry.safeParse({ key: "k", text: "x".repeat(UI_LIMITS.statusText + 1) }).success).toBe(
      false,
    );
    const lines = Array.from({ length: UI_LIMITS.panelLines + 1 }, () => "x");
    expect(Panel.safeParse({ id: "p", lines }).success).toBe(false);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "extension" }).success).toBe(true);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "someone" }).success).toBe(false);
  });

  it("starts the defaults empty", () => {
    expect(EMPTY_QUEUE).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
    expect(NO_HISTORY).toEqual({ hasMore: false, oldestEntryId: null, turnsBefore: 0 });
  });
});
