import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeKata } from "./compose-agents-vm-kata.ts";
import { composeOwnerSecrets } from "./compose-agents-vm-secrets.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { createFakeVmd, type FakeVmd } from "./modules/agent-vm/testing/fake-vmd.ts";
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
let token: string | null;
let notices: Array<[string, string]>;

const paths = () => ({ home: join(root, "pap"), agent: join(root, "agent"), bundle: join(root, "bundle") });
function parts() {
  const p = paths();
  const log = captureLogger();
  const clock = createFakeClock();
  const claudeToken = {
    status: () => (token === null ? ("missing" as const) : ("set" as const)),
    set: () => {},
    clear: () => {},
    load: () => token,
    onChange: () => {},
  };
  const ownerSecrets = composeOwnerSecrets({
    home: p.home,
    piAgentDir: p.agent,
    logger: log.logger,
    claudeToken,
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
  token = CLAUDE;
  fake = createFakeVmd();
  notices = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the profile scan knows the owner's secrets (AVM-E46)", () => {
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
