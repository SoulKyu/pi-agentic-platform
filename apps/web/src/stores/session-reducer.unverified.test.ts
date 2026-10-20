import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const user = { role: "user", content: "hi", timestamp: 1 };
const pi = (event: Record<string, unknown>) => ({ kind: "pi", event });

// J1b. Mutant: `message_end` ignores the daemon's mark -> "shows a user message the daemon marked as not sent" fails.
describe("a live user message not sent from pap (R32, J1b)", () => {
  it("shows a user message the daemon marked as not sent from pap, while the run is live", () => {
    const view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: user, unverified: true }));
    expect(view.messages.map((message) => message.unverified)).toEqual([true]);
    const plain = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: user }));
    expect(plain.messages[0]).not.toHaveProperty("unverified");
  });
});
