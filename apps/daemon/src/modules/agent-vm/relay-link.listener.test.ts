import { describe, expect, it } from "vitest";
import { bed } from "./testing/relay-link-bed.ts";

/*
 * AVM-E49 M9b: a child that reports ready while a socket that is not pap's listens on the gateway or relay address is not
 * ready; it is killed and tried again with the usual backoff. Mutant (RT-43), run for real: the fault ignored -> killed by
 * "does not become ready".
 */
describe("the relay link and the ownership of its listeners", () => {
  it("does not become ready for a foreign listener, says so, and restarts the child", async () => {
    const { link, last, lines, clock, forks } = bed({ listenerFault: () => "a foreign socket listens" });
    await link.start();
    let ready = false;
    void link.whenReady().then(() => (ready = true));
    last().ready();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(link.port()).toBeNull();
    expect(last().killed).toBe(true);
    expect(lines.some((line) => line.msg === "relay_listener_foreign")).toBe(true);
    last().die();
    await clock.advance(1000);
    expect(forks).toHaveBeenCalledTimes(2);
  });

  it("asks about the child that reported, and becomes ready when the sockets are its own", async () => {
    const asked: Array<number | undefined> = [];
    const { link, last } = bed({
      listenerFault: (child) => (asked.push(child.pid), null),
    });
    await link.start();
    last().ready();
    await link.whenReady();
    expect(link.port()).toBe(7842);
    expect(asked).toEqual([4242]);
  });
});
