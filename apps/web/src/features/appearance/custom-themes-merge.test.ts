import type { AccountAppearance, CustomTheme } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAccountDocument } from "../../lib/account-setting.ts";
import { RpcError } from "../../runtime/index.ts";
import { DEFAULT_ACCOUNT, changedAccountFields, mergeAccount, parseAccount } from "./model.ts";
import { roles } from "./theme-test-kit.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const theme = (id: string, name = id): CustomTheme => ({ id, name, base: "night", roles });
const ids = (account: AccountAppearance) => account.customThemes.map((one) => one.id);
const names = (account: AccountAppearance) => account.customThemes.map((one) => one.name);
const withThemes = (customThemes: CustomTheme[]): AccountAppearance => ({ ...DEFAULT_ACCOUNT, customThemes });
const dirty = new Set(["customThemes"]);

/** The server and two devices: each device is a real account document over the real merge. */
function twoDevices(seed: AccountAppearance = DEFAULT_ACCOUNT, onServer: AccountAppearance | null = null) {
  let stored: { value: unknown; revision: number } = { value: onServer, revision: onServer ? 1 : 0 };
  const rpc = {
    call: async (method: string, params: { baseRevision?: number; value?: unknown }) => {
      if (method === "settings.get") return stored;
      if (params.baseRevision !== stored.revision) throw new RpcError("conflict");
      stored = { value: params.value, revision: stored.revision + 1 };
      return { revision: stored.revision };
    },
  } as never;
  const device = () => {
    let state = seed;
    let due: (() => void) | null = null;
    const doc = createAccountDocument<AccountAppearance>({
      key: "appearance",
      write: (value, baseRevision) => ({ key: "appearance", value, baseRevision }) as never,
      parse: parseAccount,
      changed: changedAccountFields,
      merge: mergeAccount,
      local: () => state,
      adopt: (value) => {
        state = value;
      },
      onStatus: () => {},
      timers: {
        set: (fn) => ((due = fn), 1),
        clear: () => {
          due = null;
        },
      },
    });
    return {
      state: () => state,
      sync: () => doc.sync(rpc),
      async edit(change: (themes: CustomTheme[]) => CustomTheme[]) {
        const previous = state;
        state = { ...state, customThemes: change(state.customThemes) };
        doc.change(previous, state);
        due?.();
        for (let i = 0; i < 40; i++) await Promise.resolve();
      },
      server: () => parseAccount(stored.value),
    };
  };
  return { a: device(), b: device() };
}

describe("custom themes merge by id against the last server copy (I5)", () => {
  it("keeps both themes when a stale device adds one while the other device added another", async () => {
    const { a, b } = twoDevices();
    await a.sync();
    await b.sync();
    await a.edit((themes) => [...themes, theme("t1")]);
    await b.edit((themes) => [...themes, theme("t2")]); // b never saw t1: its save conflicts
    expect(ids(b.server())).toEqual(["t1", "t2"]);
    expect(ids(b.state())).toEqual(["t1", "t2"]);
    await a.sync();
    expect(ids(a.state())).toEqual(["t1", "t2"]);
  });

  it("keeps the other device's theme when a stale device deletes a different one", async () => {
    const { a, b } = twoDevices(withThemes([theme("t0")]));
    await a.sync();
    await a.edit((themes) => [...themes, theme("t1")]);
    await b.sync(); // b now has both
    await a.edit((themes) => [...themes, theme("t2")]);
    await b.edit((themes) => themes.filter((one) => one.id !== "t0"));
    expect(ids(b.server())).toEqual(["t1", "t2"]);
  });

  it("an edit wins over a delete of the same theme, whichever device is stale: the edited theme stays", async () => {
    const edit = (themes: CustomTheme[]) => themes.map((one) => ({ ...one, name: "Renamed" }));
    const remove = (themes: CustomTheme[]) => themes.filter((one) => one.id !== "t1");
    // The stale device edits what the other deleted: the edit re-adds it.
    const first = twoDevices(withThemes([theme("t1")]));
    await first.a.sync();
    await first.b.sync();
    await first.a.edit(remove);
    await first.b.edit(edit);
    expect(names(first.b.server())).toEqual(["Renamed"]);
    // The stale device deletes what the other edited: the delete is dropped.
    const second = twoDevices(withThemes([theme("t1")]));
    await second.a.sync();
    await second.b.sync();
    await second.a.edit(edit);
    await second.b.edit(remove);
    expect(names(second.b.server())).toEqual(["Renamed"]);
    expect(names(second.b.state())).toEqual(["Renamed"]);
  });

  it("uses the server copy the first load adopted as the base, not the cached copy the device started from", async () => {
    // a starts with an empty cache; the server already has t0.
    const { a, b } = twoDevices(DEFAULT_ACCOUNT, withThemes([theme("t0")]));
    await a.sync();
    await b.sync();
    await b.edit((themes) => [...themes, theme("t9")]);
    await a.edit((themes) => themes.filter((one) => one.id !== "t0")); // conflicts with b's save
    expect(ids(a.server())).toEqual(["t9"]);
  });

  it("uses what this device saved as the base for its next conflict", async () => {
    const { a, b } = twoDevices();
    await a.sync();
    await b.sync();
    await a.edit((themes) => [...themes, theme("t1")]); // saved: the base is now [t1]
    await b.sync();
    await b.edit((themes) => [...themes, theme("t2")]);
    await a.edit((themes) => themes.filter((one) => one.id !== "t1")); // a never saw t2: conflict
    expect(ids(a.server())).toEqual(["t2"]);
  });

  it("a delete of an untouched theme and a delete on both devices both apply", async () => {
    const { a, b } = twoDevices(withThemes([theme("t1"), theme("t2")]));
    await a.sync();
    await b.sync();
    await a.edit((themes) => themes.filter((one) => one.id !== "t1"));
    await b.edit((themes) => themes.filter((one) => one.id !== "t1" && one.id !== "t2"));
    expect(ids(b.server())).toEqual([]);
  });
});

describe("mergeAccount on the theme list", () => {
  const base = withThemes([theme("t1"), theme("t2")]);

  it("takes the server list when the list was not changed here", () => {
    const server = withThemes([theme("t1"), theme("t3")]);
    expect(ids(mergeAccount(server, base, new Set(["grid"]), base))).toEqual(["t1", "t3"]);
  });

  it("applies adds, edits and deletes made here onto the server list, in the server's order", () => {
    const server = withThemes([theme("t2"), theme("t1"), theme("t9")]);
    const local = withThemes([theme("t1", "Edited"), theme("t4")]); // t2 deleted, t1 edited, t4 added
    const merged = mergeAccount(server, local, dirty, base);
    expect(merged.customThemes.map((one) => [one.id, one.name])).toEqual([
      ["t1", "Edited"],
      ["t9", "t9"],
      ["t4", "t4"],
    ]);
  });

  it("an add whose id the server already has keeps this device's version", () => {
    const server = withThemes([theme("t1"), theme("t3", "Theirs")]);
    const local = withThemes([theme("t1"), theme("t2"), theme("t3", "Mine")]);
    expect(mergeAccount(server, local, dirty, base).customThemes.find((one) => one.id === "t3")?.name).toBe(
      "Mine",
    );
  });
});
