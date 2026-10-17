import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOnceSecrets, createVaultSink, withOnceSecrets } from "./once-secrets.ts";
import { createSecretSource } from "./policy/secrets.ts";
import { createSandboxEnvironment } from "./sandbox-env.ts";

const TOKEN = "grafana-once-value-1a2b3c";
const NOW = 1_000_000;
const FAR = NOW + 24 * 60 * 60_000;
const one = (name: string, value: string, expiresAt = FAR, id = `id-${value}`) => ({
  id,
  name,
  value,
  expiresAt,
});
const build = (clock = { now: NOW }) => {
  const used = vi.fn();
  const once = createOnceSecrets({ used, now: () => clock.now });
  once.replace([one("GRAFANA_TOKEN", TOKEN)]);
  return { once, used, clock };
};

describe("a one-use secret in the worker (M11R105)", () => {
  it("gives the value to the command that names $NAME, and only to that one", () => {
    const { once, used } = build();
    expect(once.take('curl -H "X: $GRAFANA_TOKEN" https://grafana.example/api')).toEqual({
      GRAFANA_TOKEN: TOKEN,
    });
    expect(used).toHaveBeenCalledExactlyOnceWith({ name: "GRAFANA_TOKEN", id: `id-${TOKEN}` });
    expect(once.take('curl -H "X: $GRAFANA_TOKEN" https://grafana.example/api')).toEqual({});
    expect(used).toHaveBeenCalledTimes(1);
  });

  it("is not used up by a command that does not name it", () => {
    const { once, used } = build();
    expect(once.take("ls -la")).toEqual({});
    expect(once.take("echo hello")).toEqual({});
    expect(used).not.toHaveBeenCalled();
    expect(once.entries()).toEqual([one("GRAFANA_TOKEN", TOKEN)]);
  });

  it("does not take a longer or different name for the same one", () => {
    const { once, used } = build();
    for (const command of [
      "echo $GRAFANA_TOKENS",
      "echo $GRAFANA_TOKEN_2",
      "echo ${GRAFANA_TOKENS}",
      "echo $grafana_token",
      "echo GRAFANA_TOKEN",
      "echo $GRAFANA",
    ])
      expect(once.take(command), command).toEqual({});
    expect(used).not.toHaveBeenCalled();
  });

  it("takes $NAME at the end of the text, before punctuation, and as ${NAME}", () => {
    for (const command of [
      "echo $GRAFANA_TOKEN",
      'echo "$GRAFANA_TOKEN."',
      "echo $GRAFANA_TOKEN;ls",
      "echo ${GRAFANA_TOKEN}",
      "echo ${GRAFANA_TOKEN}s",
      "echo $GRAFANA_TOKEN-x",
    ]) {
      const { once, used } = build();
      expect(once.take(command), command).toEqual({ GRAFANA_TOKEN: TOKEN });
      expect(used).toHaveBeenCalledTimes(1);
    }
  });

  it("gives the oldest of two values of one name to the first command, the next to the second", () => {
    const used = vi.fn();
    const once = createOnceSecrets({ used, now: () => NOW });
    once.replace([one("API_TOKEN", "first-value-123456"), one("API_TOKEN", "second-value-12345")]);
    expect(once.take("echo $API_TOKEN")).toEqual({ API_TOKEN: "first-value-123456" });
    expect(once.take("echo $API_TOKEN")).toEqual({ API_TOKEN: "second-value-12345" });
    expect(once.take("echo $API_TOKEN")).toEqual({});
    expect(used).toHaveBeenCalledTimes(2);
  });

  it("takes several names named by one command, each once", () => {
    const used = vi.fn();
    const once = createOnceSecrets({ used, now: () => NOW });
    once.replace([one("A_NAME", "value-a-1234567"), one("B_NAME", "value-b-1234567")]);
    expect(once.take("echo $A_NAME $B_NAME $A_NAME")).toEqual({
      A_NAME: "value-a-1234567",
      B_NAME: "value-b-1234567",
    });
    expect(used.mock.calls).toEqual([
      [{ name: "A_NAME", id: "id-value-a-1234567" }],
      [{ name: "B_NAME", id: "id-value-b-1234567" }],
    ]);
  });

  it("a failing report is said on stderr (class only) and does not give the value back", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const once = createOnceSecrets({
        used: () => {
          throw new Error(`ipc closed ${TOKEN}`);
        },
        now: () => NOW,
      });
      once.replace([one("GRAFANA_TOKEN", TOKEN)]);
      expect(() => once.take("echo $GRAFANA_TOKEN")).not.toThrow();
      expect(once.take("echo $GRAFANA_TOKEN")).toEqual({});
      const said = write.mock.calls.map((call) => String(call[0])).join("");
      expect(said).toContain("secret_used not sent");
      expect(said).not.toContain(TOKEN);
    } finally {
      write.mockRestore();
    }
  });
});

describe("the daemon's list is authoritative (W5-R37)", () => {
  it("replaces the whole set on each record: a value the daemon no longer lists is gone (dropAgent, a sweep, a reset)", () => {
    const { once } = build();
    once.replace([one("OTHER_NAME", "other-value-123456")]);
    expect(once.entries()).toEqual([one("OTHER_NAME", "other-value-123456")]);
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({});
    once.replace([]);
    expect(once.entries()).toEqual([]);
    expect(once.take("echo $OTHER_NAME")).toEqual({});
  });

  it("keeps the same value once, however often a record repeats it", () => {
    const { once } = build();
    once.replace([one("GRAFANA_TOKEN", TOKEN), one("GRAFANA_TOKEN", TOKEN)]);
    once.replace([one("GRAFANA_TOKEN", TOKEN)]);
    expect(once.entries()).toHaveLength(1);
  });

  it("does not hand out a value whose expiresAt has passed on the worker's own clock", () => {
    const { once, used, clock } = build();
    clock.now = FAR - 1;
    expect(once.entries()).toHaveLength(1);
    clock.now = FAR;
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({});
    expect(used).not.toHaveBeenCalled();
    expect(once.entries()).toEqual([]);
  });

  it("a record that lists an expired value does not bring it back", () => {
    const { once, clock } = build();
    clock.now = FAR + 5;
    once.replace([one("GRAFANA_TOKEN", TOKEN)]);
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({});
  });

  it("heals a lost secret_used: the next record lists the value again, the worker does not hand it out twice and tells the daemon again", () => {
    const { once, used } = build();
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({ GRAFANA_TOKEN: TOKEN });
    once.replace([one("GRAFANA_TOKEN", TOKEN), one("OTHER_NAME", "other-value-123456")]);
    expect(once.entries()).toEqual([one("OTHER_NAME", "other-value-123456")]);
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({});
    expect(used.mock.calls).toEqual([
      [{ name: "GRAFANA_TOKEN", id: `id-${TOKEN}` }],
      [{ name: "GRAFANA_TOKEN", id: `id-${TOKEN}` }],
    ]);
  });

  it("holds at most three and says so by name class when a record lists more, never skipping silently", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const once = createOnceSecrets({ used: () => {}, now: () => NOW });
      once.replace([
        one("A_NAME", "value-a-1234567"),
        one("B_NAME", "value-b-1234567"),
        one("C_NAME", "value-c-1234567"),
        one("D_NAME", "value-d-1234567"),
      ]);
      expect(once.entries().map((entry) => entry.name)).toEqual(["A_NAME", "B_NAME", "C_NAME"]);
      const said = write.mock.calls.map((call) => String(call[0])).join("");
      expect(said).toContain("one-use value not held");
      expect(said).toContain("D_NAME");
      expect(said).not.toContain("value-d-1234567");
    } finally {
      write.mockRestore();
    }
  });
});

describe("each one-use value has its own id (N1, N2)", () => {
  it("N1: the same token answered again for a new request is held and handed to the next command", () => {
    const { once, used } = build();
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({ GRAFANA_TOKEN: TOKEN });
    once.replace([one("GRAFANA_TOKEN", TOKEN, FAR, "second-request")]);
    expect(once.entries()).toEqual([one("GRAFANA_TOKEN", TOKEN, FAR, "second-request")]);
    expect(once.take("echo $GRAFANA_TOKEN")).toEqual({ GRAFANA_TOKEN: TOKEN });
    expect(used.mock.calls).toEqual([
      [{ name: "GRAFANA_TOKEN", id: `id-${TOKEN}` }],
      [{ name: "GRAFANA_TOKEN", id: "second-request" }],
    ]);
  });

  it("two waiting answers with the same value are both held and both used", () => {
    const used = vi.fn();
    const once = createOnceSecrets({ used, now: () => NOW });
    once.replace([one("API_TOKEN", TOKEN, FAR, "r1"), one("API_TOKEN", TOKEN, FAR, "r2")]);
    expect(once.entries().map((entry) => entry.id)).toEqual(["r1", "r2"]);
    expect(once.take("echo $API_TOKEN")).toEqual({ API_TOKEN: TOKEN });
    expect(once.take("echo $API_TOKEN")).toEqual({ API_TOKEN: TOKEN });
    expect(once.take("echo $API_TOKEN")).toEqual({});
    expect(used.mock.calls.map((call) => call[0].id)).toEqual(["r1", "r2"]);
  });

  it("a record that lists a used id again does not revive it", () => {
    const { once } = build();
    once.take("echo $GRAFANA_TOKEN");
    once.replace([one("GRAFANA_TOKEN", TOKEN)]);
    expect(once.entries()).toEqual([]);
  });
});

describe("withOnceSecrets: the sandboxed shell's environment", () => {
  const sandbox = { home: "/home/u/.pap/agents/atlas-1a2b", network: false };

  it("adds the value to the one command that names it and leaves the vault alone", () => {
    const { once } = build();
    const environment = withOnceSecrets(
      createSandboxEnvironment({ PATH: "/usr/bin" }, sandbox, { VAULT_NAME: "vault-value-123456" }),
      once,
    );
    const first = environment.envFor("curl $GRAFANA_TOKEN");
    expect(first).toMatchObject({
      GRAFANA_TOKEN: TOKEN,
      VAULT_NAME: "vault-value-123456",
      HOME: sandbox.home,
    });
    const second = environment.envFor("curl $GRAFANA_TOKEN");
    expect(second).not.toHaveProperty("GRAFANA_TOKEN");
    expect(second).toMatchObject({ VAULT_NAME: "vault-value-123456" });
  });

  it("the one-use value wins over a vault entry of the same name, for that command only", () => {
    const { once } = build();
    const environment = withOnceSecrets(
      createSandboxEnvironment({}, sandbox, { GRAFANA_TOKEN: "saved-value-12345678" }),
      once,
    );
    expect(environment.envFor("echo $GRAFANA_TOKEN").GRAFANA_TOKEN).toBe(TOKEN);
    expect(environment.envFor("echo $GRAFANA_TOKEN").GRAFANA_TOKEN).toBe("saved-value-12345678");
  });

  it("passes setVault through", () => {
    const { once } = build();
    const environment = withOnceSecrets(createSandboxEnvironment({}, sandbox, {}), once);
    environment.setVault({ NEW_NAME: "new-value-1234567" });
    expect(environment.envFor("ls")).toMatchObject({ NEW_NAME: "new-value-1234567" });
  });
});

describe("the vault sink: what a vault_update does in the worker (M11R105)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const sandbox = { home: "/home/u/.pap/agents/atlas-1a2b", network: false };
  const open = () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pap-once-"));
    dirs.push(agentDir);
    const source = createSecretSource({ env: {}, agentDir });
    const used = vi.fn();
    const once = createOnceSecrets({ used, now: () => NOW });
    const environment = withOnceSecrets(createSandboxEnvironment({}, sandbox, {}), once);
    return { source, used, once, environment, sink: createVaultSink({ source, environment, once }) };
  };
  const redacted = (source: ReturnType<typeof open>["source"], text: string): string =>
    source.current().text(text).text;

  it("redacts the one-use value from the moment it arrives, as [SECRET:NAME]", () => {
    const { source, sink } = open();
    sink.update({ vault: {}, once: [one("GRAFANA_TOKEN", TOKEN)] });
    expect(redacted(source, `x ${TOKEN} y`)).toBe("x [SECRET:GRAFANA_TOKEN] y");
  });

  it("C1: two values of one name are both redacted, in init and in a later update, whichever the command gets", () => {
    const first = "first-token-value-aaaa1111";
    const second = "second-token-value-bbbb2222";
    for (const path of ["init", "drift"] as const) {
      const { source, environment, sink } = open();
      if (path === "drift") sink.update({ vault: {}, once: [] });
      sink.update({ vault: {}, once: [one("API_TOKEN", first), one("API_TOKEN", second)] });
      // The command receives the OLDER value and prints it: the output must not show it.
      const env = environment.envFor('curl -v -H "Authorization: Bearer $API_TOKEN"');
      expect(env.API_TOKEN, path).toBe(first);
      const output = redacted(source, `Authorization: Bearer ${env.API_TOKEN} / ${second}`);
      expect(output, path).not.toContain(first);
      expect(output, path).not.toContain(second);
      expect(output, path).toMatch(
        /^Authorization: Bearer \[SECRET:API_TOKEN(_2)?\] \/ \[SECRET:API_TOKEN(_2)?\]$/,
      );
    }
  });

  it("keeps redacting it after the command used it, and after a later vault update with no once", () => {
    const { source, environment, used, sink } = open();
    sink.update({ vault: {}, once: [one("GRAFANA_TOKEN", TOKEN)] });
    expect(environment.envFor("echo $GRAFANA_TOKEN").GRAFANA_TOKEN).toBe(TOKEN);
    expect(used).toHaveBeenCalledTimes(1);
    expect(redacted(source, TOKEN)).toBe("[SECRET:GRAFANA_TOKEN]");
    sink.update({ vault: { OTHER_NAME: "other-value-123456" }, once: [] });
    expect(redacted(source, `${TOKEN} other-value-123456`)).toBe(
      "[SECRET:GRAFANA_TOKEN] [SECRET:OTHER_NAME]",
    );
    expect(environment.envFor("echo $GRAFANA_TOKEN")).not.toHaveProperty("GRAFANA_TOKEN");
  });

  it("an update that lists the waiting value leaves it for its command", () => {
    const { environment, sink } = open();
    sink.update({ vault: {}, once: [one("GRAFANA_TOKEN", TOKEN)] });
    sink.update({ vault: { SAVED_NAME: "saved-value-123456" }, once: [one("GRAFANA_TOKEN", TOKEN)] });
    expect(environment.envFor("echo $GRAFANA_TOKEN")).toMatchObject({
      GRAFANA_TOKEN: TOKEN,
      SAVED_NAME: "saved-value-123456",
    });
  });

  it("an update with an empty list empties the set, and the dropped value stays redacted", () => {
    const { source, environment, sink } = open();
    sink.update({ vault: {}, once: [one("GRAFANA_TOKEN", TOKEN)] });
    sink.update({ vault: {}, once: [] });
    expect(environment.envFor("echo $GRAFANA_TOKEN")).not.toHaveProperty("GRAFANA_TOKEN");
    expect(redacted(source, TOKEN)).toBe("[SECRET:GRAFANA_TOKEN]");
  });

  it("redacts both values when the vault and a one-use value share a name", () => {
    const { source, sink } = open();
    sink.update({ vault: { GRAFANA_TOKEN: "saved-value-123456" }, once: [one("GRAFANA_TOKEN", TOKEN)] });
    const text = redacted(source, `saved-value-123456 ${TOKEN}`);
    expect(text).not.toContain("saved-value-123456");
    expect(text).not.toContain(TOKEN);
    expect(text).toMatch(/^\[SECRET:GRAFANA_TOKEN(_2)?\] \[SECRET:GRAFANA_TOKEN(_2)?\]$/);
  });

  it("the start gives the same: init's vault and its once values", () => {
    const { source, environment, sink } = open();
    sink.update({ vault: { SAVED_NAME: "saved-value-123456" }, once: [one("GRAFANA_TOKEN", TOKEN)] });
    expect(redacted(source, `${TOKEN} saved-value-123456`)).toBe(
      "[SECRET:GRAFANA_TOKEN] [SECRET:SAVED_NAME]",
    );
    expect(environment.envFor("ls")).toMatchObject({ SAVED_NAME: "saved-value-123456" });
    expect(environment.envFor("ls")).not.toHaveProperty("GRAFANA_TOKEN");
  });
});
