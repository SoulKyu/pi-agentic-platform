import { beforeEach, describe, expect, it } from "vitest";
import { useInboxReveal } from "./inbox-reveal.ts";

beforeEach(() => useInboxReveal.getState().clear());

describe("useInboxReveal", () => {
  it("is asked once for the shell to open the Inbox and once for the panel to find the row", () => {
    useInboxReveal.getState().ask("q1");
    expect(useInboxReveal.getState().takeOpen()).toBe(true);
    expect(useInboxReveal.getState().takeOpen()).toBe(false);
    expect(useInboxReveal.getState().takeItem()).toBe("q1");
    expect(useInboxReveal.getState().takeItem()).toBeNull();
  });

  it("asks for the Inbox alone when no item is named", () => {
    useInboxReveal.getState().ask(null);
    expect(useInboxReveal.getState().takeOpen()).toBe(true);
    expect(useInboxReveal.getState().takeItem()).toBeNull();
  });

  it("clear forgets a request (sign-out)", () => {
    useInboxReveal.getState().ask("q1");
    useInboxReveal.getState().clear();
    expect(useInboxReveal.getState()).toMatchObject({ open: false, itemId: null });
  });
});
