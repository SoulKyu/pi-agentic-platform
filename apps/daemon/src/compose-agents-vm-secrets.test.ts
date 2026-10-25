import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeAgentsVmRpc } from "./compose-agents-vm-rpc.ts";
import { composeKata } from "./compose-agents-vm-kata.ts";
import { composeOwnerSecrets } from "./compose-agents-vm-secrets.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { createFakeVmd, type FakeVmd } from "./modules/agent-vm/testing/fake-vmd.ts";
import { createStderrRedactor, redactionSource, secretsDirOf } from "./modules/agent-vm/index.ts";
import { OWNER_SECRETS_CAP_NOTICE, OwnerSecretsError } from "./modules/agent-vm/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";
import { captureLogger } from "./testing/capture-logger.ts";

/*
 * Mutants (RT-43), each run for real in the T15b report: "default back to refusedSecrets" (the clean-profile case fails), "auth.json
 * left out", "vault left out", "Claude token left out" (one refused-profile case each), "providers not passed" (the relay-entry
 * case), "failure swallowed" (the failing-source case).
 */
const ID = "scout-0001";
const AUTH_KEY = `sk-test-${"A".repeat(24)}`;
const VAULT_VALUE = `vault-value-${"E".repeat(10)}`;
const CLAUDE = `claude-token-${"F".repeat(16)}`;
const NODE = `docker.io/library/node@sha256:${"9".repeat(64)}`;
let root: string;
let fake: FakeVmd;
let notices: Array<[string, string]>;

const paths = () => ({ home: join(root, "pap"), agent: join(root, "agent"), bundle: join(root, "bundle") });
function parts() {
  const p = paths();
  const log = captureLogger();
  const clock = createFakeClock();
  const ownerSecrets = composeOwnerSecrets({
    home: p.home,
    piAgentDir: p.agent,
    logger: log.logger,
    ownerId: () => "owner1",
  });
  const kata = composeKata(
    { home: p.home, piAgentDir: p.agent, clock, logger: log.logger, ownerSecrets },
    { client: fake, bundleRoot: p.bundle, nodeImage: NODE },
    (agentId, text) => void notices.push([agentId, text]),
  );
  return { kata, log };
}
const build = (kata: ReturnType<typeof parts>["kata"]) =>
  kata.imageTagOf(ID, AgentInput.parse({ name: "Scout" }), "thread");
const plant = (rel: string, text: string): void => {
  const file = join(paths().agent, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t15b-compose-"));
  const p = paths();
  mkdirSync(p.agent, { recursive: true });
  mkdirSync(p.bundle, { recursive: true });
  writeFileSync(join(p.bundle, "package.json"), "{}");
  writeFileSync(join(p.agent, "settings.json"), "{}");
  writeFileSync(
    join(p.agent, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: AUTH_KEY },
      "only-in-auth": { type: "api_key", key: "z".repeat(20) },
    }),
  );
  createVaultStore(vaultRootOf(p.home)).set(
    "owner1",
    { kind: "agent", agentId: ID },
    "TOKEN",
    VAULT_VALUE,
    1,
  );
  createVaultStore(vaultRootOf(p.home)).set("owner1", { kind: "user" }, "CLAUDE_TOKEN", CLAUDE, 1);
  fake = createFakeVmd();
  notices = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// S1 item 8 (M14: the token is in the vault). Mutant: the RPC's store seals into another vault root -> this case fails.
describe("the Claude token's vault is the collector's", () => {
  it("the RPC's store writes where the collector reads, for any user", async () => {
    const home = paths().home;
    expect(secretsDirOf(home)).toBe(join(home, "secrets"));
    const { claudeToken } = composeAgentsVmRpc({ home }, captureLogger().logger, createFakeClock(), {
      append: () => {},
    } as never);
    const NEW = `claude-token-${"G".repeat(16)}`;
    claudeToken.set("member1", NEW);
    const collected = await redactionSource(
      composeOwnerSecrets({ home, piAgentDir: paths().agent, logger: captureLogger().logger }),
    )();
    expect(collected.secrets).toContain(NEW);
  });
});

// S1 item 9. Mutant: the redactor reads the all-or-nothing collector again -> "keeps the values of the sources that read" fails.
describe("the relay's stderr redactor with a broken source", () => {
  it("keeps the values of the sources that read, while the build still refuses", async () => {
    writeFileSync(join(paths().agent, "auth.json"), "{ not json");
    const collector = composeOwnerSecrets({
      home: paths().home,
      piAgentDir: paths().agent,
      logger: captureLogger().logger,
    });
    await expect(collector()).rejects.toBeInstanceOf(OwnerSecretsError);
    const redact = createStderrRedactor({ clock: createFakeClock(), collect: redactionSource(collector) });
    const masked = await redact(`a ${VAULT_VALUE} b ${CLAUDE} c`);
    expect(masked).toBe("a [REDACTED] b [REDACTED] c");
  });
});

describe("the profile scan uses the install's secrets only (R13)", () => {
  const MEMBER_VALUE = "extensions";
  const memberVault = (value: string) =>
    createVaultStore(vaultRootOf(paths().home)).set("member1", { kind: "user" }, "NOTE", value, 1);

  it("a member's vault value equal to a profile file's name or text leaves the build unchanged", async () => {
    plant("skills/extensions/SKILL.md", "uses extensions and package.json everywhere");
    const before = await build(parts().kata);
    memberVault(MEMBER_VALUE);
    memberVault("package.json");
    await expect(build(parts().kata)).resolves.toBe(before);
  });

  it("the owner's own vault value in a profile file still refuses the build", async () => {
    plant("skills/leak/SKILL.md", `token ${VAULT_VALUE}`);
    await expect(build(parts().kata)).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("a damaged member vault does not block the build, and a damaged owner vault does", async () => {
    memberVault(MEMBER_VALUE);
    writeFileSync(join(paths().home, "secrets", "vault", "member1", "user.json"), "{ not json");
    await expect(build(parts().kata)).resolves.toMatch(/^pap-agent-/);
    writeFileSync(join(paths().home, "secrets", "vault", "owner1", "user.json"), "{ not json");
    await expect(build(parts().kata)).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("every user's values are still redacted from relay logs; a damaged vault of another user is skipped", async () => {
    const MEMBER_SECRET = `member-secret-${"H".repeat(10)}`;
    memberVault(MEMBER_SECRET);
    const log = captureLogger();
    const collector = composeOwnerSecrets({
      home: paths().home,
      piAgentDir: paths().agent,
      logger: log.logger,
      ownerId: () => "owner1",
    });
    const redact = createStderrRedactor({ clock: createFakeClock(), collect: redactionSource(collector) });
    expect(await redact(`a ${MEMBER_SECRET} b ${CLAUDE}`)).toBe("a [REDACTED] b [REDACTED]");
    createVaultStore(vaultRootOf(paths().home)).set("member2", { kind: "user" }, "X", "other-value-12345", 1);
    writeFileSync(join(paths().home, "secrets", "vault", "member2", "user.json"), "{ not json");
    const again = createStderrRedactor({ clock: createFakeClock(), collect: redactionSource(collector) });
    expect(await again(`a ${MEMBER_SECRET} b`)).toBe("a [REDACTED] b");
  });
});

describe("the profile scan knows the owner's secrets (AVM-E46)", () => {
  // AVM-E50: a README naming the reference is not a leak.
  it("builds a profile whose README names $OPENAI_API_KEY when auth.json holds that reference", async () => {
    writeFileSync(
      join(paths().agent, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: "$OPENAI_API_KEY" },
        cmd: { type: "api_key", key: "!pass show openai/key" },
      }),
    );
    plant("skills/hello/SKILL.md", "set $OPENAI_API_KEY, or use !pass show openai/key");
    const { kata } = parts();
    await expect(build(kata)).resolves.toMatch(/^pap-agent-/);
  });

  // m6: a cap refusal tells the owner why, in the thread.
  it("posts a notice naming the cause when the cap refuses", async () => {
    const p = paths();
    const log = captureLogger();
    const kata = composeKata(
      { home: p.home, piAgentDir: p.agent, clock: createFakeClock(), logger: log.logger },
      {
        client: fake,
        bundleRoot: p.bundle,
        nodeImage: NODE,
        knownSecrets: () => {
          throw new OwnerSecretsError("too_many");
        },
      },
      (agentId, text) => void notices.push([agentId, text]),
    );
    await expect(build(kata)).rejects.toMatchObject({ code: "config_invalid" });
    expect(notices).toEqual([[ID, OWNER_SECRETS_CAP_NOTICE]]);
  });

  // m8: the second vault reader must not sweep the daemon's own store's temporary files.
  it("does not sweep the vault's temporary files (sweep:false)", async () => {
    const temp = join(vaultRootOf(paths().home), "owner1", `user.json.${"a".repeat(12)}.tmp`);
    writeFileSync(temp, "in flight");
    const { kata } = parts();
    await build(kata);
    expect(existsSync(temp)).toBe(true);
  });

  it("builds a clean profile", async () => {
    const { kata } = parts();
    await expect(build(kata)).resolves.toMatch(/^pap-agent-/);
  });

  it.each([
    ["an auth.json value", AUTH_KEY],
    ["a vault value", VAULT_VALUE],
    ["the Claude token", CLAUDE],
  ])("refuses a profile file that holds %s, and the log names no value", async (_name, value) => {
    plant("skills/hello/SKILL.md", `use ${value} to log in`);
    const { kata, log } = parts();
    await expect(build(kata)).rejects.toMatchObject({ code: "config_invalid" });
    expect(fake.of("image.build").filter((one) => one.layer === "profile")).toEqual([]);
    const text = JSON.stringify(log.lines) + JSON.stringify(notices);
    for (const secret of [AUTH_KEY, VAULT_VALUE, CLAUDE]) expect(text).not.toContain(secret);
  });

  it("refuses the build when auth.json cannot be read, with no value in the log", async () => {
    writeFileSync(join(paths().agent, "auth.json"), `{ "a": "${AUTH_KEY}" oops`);
    const { kata, log } = parts();
    await expect(build(kata)).rejects.toMatchObject({ code: "config_invalid" });
    expect(JSON.stringify(log.lines)).not.toContain(AUTH_KEY);
  });

  it("gives a provider known only from auth.json its relay entry", async () => {
    const { kata } = parts();
    await build(kata);
    const models = JSON.parse(
      readFileSync(join(paths().home, "vm", "build", "profile", "pi-agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { baseUrl: string }> };
    expect(Object.keys(models.providers).sort()).toEqual(["anthropic", "only-in-auth"]);
    expect(models.providers["only-in-auth"]?.baseUrl).toMatch(/only-in-auth$/);
  });
});
