import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

describe("reduceSession server codes", () => {
  it("keeps the code and params of a coded cause or notice, and nothing for an uncoded one (R128)", () => {
    const cause = reduceSession(EMPTY_VIEW, {
      kind: "status",
      status: "cold",
      cause: "Agent process exited with code 70.",
      causeCode: "process_exit_code",
      causeParams: { code: "70" },
    });
    expect(cause.notices).toEqual([
      {
        level: "error",
        text: "Agent process exited with code 70.",
        code: "process_exit_code",
        params: { code: "70" },
      },
    ]);
    const coded = reduceSession(EMPTY_VIEW, {
      kind: "notice",
      level: "warning",
      text: "An extension failed.",
      code: "extension_failed",
    });
    expect(coded.notices).toEqual([
      { level: "warning", text: "An extension failed.", code: "extension_failed" },
    ]);
    const plain = reduceSession(EMPTY_VIEW, {
      kind: "notice",
      level: "info",
      text: "hi",
      source: "extension",
    });
    expect(plain.notices).toEqual([{ level: "info", text: "hi", source: "extension" }]);
  });
});
