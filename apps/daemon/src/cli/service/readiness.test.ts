import { describe, expect, it } from "vitest";
import type { Systemd } from "./systemd.ts";
import { waitForListening } from "./readiness.ts";

const ID = "0123456789abcdef0123456789abcdef";
const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const SETUP = '{"msg":"setup_url","url":"http://localhost:7777/setup?token=abc"}';
const OTHER = '{"msg":"boot"}';
const SINCE = new Date(Date.UTC(2026, 9, 15, 12, 0, 5, 700));

function harness(options: { ids?: Array<string | null>; journals: string[]; any?: string }) {
  const log = {
    ids: 0,
    journals: [] as string[],
    fallbacks: [] as boolean[],
    any: [] as string[],
    sleeps: [] as number[],
  };
  const systemd = {
    invocationId: async () => {
      const ids = options.ids ?? [];
      const next = ids.length === 0 ? ID : ids[Math.min(log.ids, ids.length - 1)];
      log.ids++;
      return next === undefined ? ID : next;
    },
    journalAny: async (since: string) => {
      log.any.push(since);
      return options.any ?? "Started pap.service.\n";
    },
    journal: async (id: string, since: string, fallback: boolean) => {
      log.journals.push(`${id} ${since}`);
      log.fallbacks.push(fallback);
      return options.journals[Math.min(log.journals.length - 1, options.journals.length - 1)] ?? "";
    },
    isActive: async () => true, // the Type=simple trap: always yes
  } as unknown as Systemd;
  const deps = {
    systemd,
    sleep: async (ms: number) => {
      log.sleeps.push(ms);
    },
    now: () => SINCE,
  };
  return { deps, log };
}

describe("waitForListening", () => {
  it("returns the setup URL when the journal has listening and a URL", async () => {
    const { deps, log } = harness({ journals: [`${SETUP}\n${LISTENING}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({
      kind: "url",
      url: "http://localhost:7777/setup?token=abc",
    });
    expect(log.journals).toEqual([`${ID} 2026-10-15 12:00:05 UTC`]);
    expect(log.sleeps).toEqual([]);
  });

  it("returns owner only on the second consecutive read of listening without a URL (M1a)", async () => {
    const { deps, log } = harness({ journals: [`${LISTENING}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({ kind: "owner" });
    expect(log.journals).toHaveLength(2);
    expect(log.sleeps).toEqual([500]);
  });

  it("a setup URL that lands between the listening line and the next read wins over owner (M1a)", async () => {
    const { deps } = harness({ journals: [`${LISTENING}\n`, `${SETUP}\n${LISTENING}\n`] });
    expect((await waitForListening(deps, "pap.service", SINCE, 7777)).kind).toBe("url");
  });

  it("an empty read between two listening reads resets the owner count (M1a)", async () => {
    const { deps, log } = harness({ journals: [`${LISTENING}\n`, "", `${LISTENING}\n`, `${LISTENING}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({ kind: "owner" });
    expect(log.journals).toHaveLength(4);
  });

  it("ignores a setup URL whose port is not the installed one (M1c)", async () => {
    const { deps, log } = harness({ journals: [`${SETUP}\n${LISTENING}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7790)).toEqual({ kind: "owner" });
    expect(log.journals).toHaveLength(2);
  });

  it("uses the --since fallback only after several empty reads (M1b)", async () => {
    const { deps, log } = harness({ journals: ["", "", "", "", "", "", `${SETUP}\n${LISTENING}\n`] });
    await waitForListening(deps, "pap.service", SINCE, 7777);
    expect(log.fallbacks).toEqual([false, false, false, false, true, true, true]);
  });

  it("says unreadable when nothing was heard and the unmatched journal is empty too (I2)", async () => {
    const { deps, log } = harness({ journals: [""], any: "" });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({ kind: "unreadable" });
    expect(log.journals).toHaveLength(40);
    expect(log.any).toEqual(["2026-10-15 12:00:05 UTC"]);
  });

  it("returns never after exactly 40 reads and 39 sleeps although is-active says yes", async () => {
    const { deps, log } = harness({ journals: [`${OTHER}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({ kind: "never" });
    expect(log.journals).toHaveLength(40);
    expect(log.any).toHaveLength(1);
    expect(log.sleeps).toEqual(Array.from({ length: 39 }, () => 500));
  });

  it("retries while the invocation id is null", async () => {
    const { deps, log } = harness({ ids: [null, null, ID], journals: [`${LISTENING}\n`] });
    expect(await waitForListening(deps, "pap.service", SINCE, 7777)).toEqual({ kind: "owner" });
    expect(log.ids).toBe(4);
    expect(log.sleeps).toEqual([500, 500, 500]);
  });

  it("answers on the first read that has the line, without waiting the rest", async () => {
    const { deps, log } = harness({ journals: ["", "", `${SETUP}\n${LISTENING}\n`] });
    const result = await waitForListening(deps, "pap.service", SINCE, 7777);
    expect(result.kind).toBe("url");
    expect(log.journals).toHaveLength(3);
    expect(log.sleeps).toEqual([500, 500]);
  });
});
