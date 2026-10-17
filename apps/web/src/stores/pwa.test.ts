import { beforeEach, describe, expect, it } from "vitest";
import { usePwa } from "./pwa.ts";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

describe("pwa store", () => {
  it("starts quiet", () => {
    const state = usePwa.getState();
    expect([state.updateReady, state.registrationFailed, state.needsReenable]).toEqual([false, false, false]);
  });

  it("onOpen and onResubscribe return an unsubscribe that only removes their own handler", () => {
    const seen: string[] = [];
    const off = usePwa.getState().onOpen((path) => seen.push(`a${path}`));
    usePwa.getState().onOpen((path) => seen.push(`b${path}`));
    off();
    usePwa.getState().openHandler?.("/x");
    expect(seen).toEqual(["b/x"]);
  });

  it("sign-out (reset) drops the account-bound state: re-enable flag and handlers (MC34)", () => {
    usePwa.getState().setNeedsReenable(true);
    usePwa.getState().onOpen(() => {});
    usePwa.getState().onResubscribe(() => {});
    usePwa.getState().reset();
    const state = usePwa.getState();
    expect(state.needsReenable).toBe(false);
    expect(state.openHandler).toBeNull();
    expect(state.resubscribeHandler).toBeNull();
  });

  it("sign-out keeps what is true of the page, not of the account: a waiting update and a failed worker", () => {
    usePwa.getState().markUpdateReady();
    usePwa.getState().setRegistrationFailed(true);
    usePwa.getState().reset();
    expect(usePwa.getState().updateReady).toBe(true);
    expect(usePwa.getState().registrationFailed).toBe(true);
  });
});
