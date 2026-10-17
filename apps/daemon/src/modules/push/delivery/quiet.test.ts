import { describe, expect, it } from "vitest";
import { nextQuietEnd } from "./quiet.ts";

const NIGHT = { from: "22:00", to: "07:00" } as const;
const PARIS = "Europe/Paris";

describe("quiet.end.dst", () => {
  it("returns null outside a window, without hours and for from === to", () => {
    expect(nextQuietEnd(NIGHT, PARIS, Date.UTC(2026, 5, 1, 12, 0))).toBeNull();
    expect(nextQuietEnd(null, PARIS, Date.UTC(2026, 5, 1, 23, 0))).toBeNull();
    expect(nextQuietEnd({ from: "08:00", to: "08:00" }, PARIS, Date.UTC(2026, 5, 1, 8, 0))).toBeNull();
  });

  it("the window starting now returns its end", () => {
    // 22:00 in Paris in June is 20:00Z; the end is 07:00 local, 05:00Z.
    expect(nextQuietEnd(NIGHT, PARIS, Date.UTC(2026, 5, 1, 20, 0))).toBe(Date.UTC(2026, 5, 2, 5, 0));
  });

  it("is minute aligned when now is not", () => {
    expect(nextQuietEnd(NIGHT, PARIS, Date.UTC(2026, 5, 1, 23, 10, 17))).toBe(Date.UTC(2026, 5, 2, 5, 0));
  });

  it("spring forward (2026-03-29): the end is 07:00 wall clock, 7.5 h later, not 9 h", () => {
    const now = Date.UTC(2026, 2, 28, 21, 30); // 22:30 CET
    const end = nextQuietEnd(NIGHT, PARIS, now);
    expect(end).toBe(Date.UTC(2026, 2, 29, 5, 0)); // 07:00 CEST
    expect((end as number) - now).toBe(7.5 * 3_600_000);
  });

  it("spring forward: from inside the night after the jump", () => {
    expect(nextQuietEnd(NIGHT, PARIS, Date.UTC(2026, 2, 29, 1, 30))).toBe(Date.UTC(2026, 2, 29, 5, 0));
  });

  it("autumn back (2026-10-25): the end is 07:00 wall clock, 9.5 h later", () => {
    const now = Date.UTC(2026, 9, 24, 20, 30); // 22:30 CEST
    const end = nextQuietEnd(NIGHT, PARIS, now);
    expect(end).toBe(Date.UTC(2026, 9, 25, 6, 0)); // 07:00 CET
    expect((end as number) - now).toBe(9.5 * 3_600_000);
  });

  it("autumn back: the repeated hour is still inside the window", () => {
    expect(nextQuietEnd(NIGHT, PARIS, Date.UTC(2026, 9, 25, 1, 30))).toBe(Date.UTC(2026, 9, 25, 6, 0));
  });

  it("a daytime window ends at its own end", () => {
    expect(nextQuietEnd({ from: "13:00", to: "14:30" }, PARIS, Date.UTC(2026, 5, 1, 11, 5))).toBe(
      Date.UTC(2026, 5, 1, 12, 30),
    );
  });
});
