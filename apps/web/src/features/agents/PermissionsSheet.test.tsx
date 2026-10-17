// @vitest-environment happy-dom
import type { PermissionsView } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { mount, text } from "../../testing/dom.ts";
import { PermissionsSheet } from "./PermissionsSheet.tsx";

const quiet: PermissionsView = {
  tools: { preset: "default", active: ["read", "bash", "edit", "write"] },
  sandbox: { required: true, effective: "on", network: true },
  hosts: ["api.github.com", "*.npmjs.org"],
  blocked: 3,
  vaultNames: ["GITHUB_TOKEN"],
  triggers: [{ name: "Nightly digest", source: "schedule", target: "isolated" }],
  mcp: "owner's servers",
  trustedSources: [],
  trustedAutonomy: false,
  egress: "proxied",
  trifecta: { privateData: false, untrustedContent: false, exfiltration: false },
};
const legs = (patch: Partial<PermissionsView["trifecta"]>): PermissionsView["trifecta"] => ({
  ...quiet.trifecta,
  ...patch,
});
const shown = async (view: PermissionsView) =>
  text((await mount(<PermissionsSheet view={view} />)).container);

afterEach(() => setLocale("en"));

describe("the trifecta as advice (M11R126, M11R116)", () => {
  it("says what each leg means for a live thread, with 'can'", async () => {
    const words = await shown({ ...quiet, trifecta: legs({ privateData: true }) });
    expect(words).toContain("1 of 3");
    expect(words).toContain("This agent can read private data");
    expect(words).toContain("This agent reads no untrusted content that pap knows of");
    expect(words).toContain("This agent cannot send data out");
    expect(words).not.toContain("may read");
  });

  it("names the untrusted-content leg and the exfiltration leg, the latter with the hosts the proxy lets it reach", async () => {
    const words = await shown({ ...quiet, trifecta: legs({ untrustedContent: true, exfiltration: true }) });
    expect(words).toContain("2 of 3");
    expect(words).toContain("This agent can read untrusted content");
    expect(words).toContain("This agent can send data out");
    expect(words).toContain("any host the proxy lets it reach");
  });

  it("reads 'may' for every leg while no thread has told what is active", async () => {
    const words = await shown({
      ...quiet,
      tools: { preset: "default", active: "unknown-until-start" },
      trifecta: legs({ privateData: true, exfiltration: true }),
    });
    expect(words).toContain("This agent may read private data");
    expect(words).toContain("This agent may send data out");
    expect(words).not.toContain("This agent can read private data");
    expect(words).not.toContain("This agent can send data out");
    expect(words).toContain("listed once its thread has started");
  });

  it("gives the 3 of 3 advice and what would remove a leg", async () => {
    const words = await shown({
      ...quiet,
      trifecta: { privateData: true, untrustedContent: true, exfiltration: true },
    });
    expect(words).toContain(
      "3 of 3: this agent can read private data, read untrusted content and send data out.",
    );
    expect(words).toContain("advice, nothing is blocked");
    expect(words).toContain("To remove a leg");
    expect(words).toContain("keep the sandbox on");
    expect(words).toContain("webhook and feed triggers");
    expect(words).toContain("turn the sandbox network off");
  });

  it("does not name the proxy in the advice while the sandbox is unavailable: the shell cannot start", async () => {
    const view: PermissionsView = {
      ...quiet,
      sandbox: { required: true, effective: "unavailable", network: true },
      trifecta: { privateData: true, untrustedContent: true, exfiltration: true },
    };
    // The advice line of the exfiltration leg, up to its closing parenthesis.
    const advice = async () =>
      /(?:Sending data out|Envoi de données) ?:[^)]*\)/.exec(await shown(view))?.[0] ?? "";
    const english = await advice();
    expect(english).toContain("remove its web tools and MCP servers");
    expect(english).not.toMatch(/proxy/i);
    expect(english).not.toContain("turn the sandbox network off");
    setLocale("fr");
    const french = await advice();
    expect(french).toContain("retirez ses outils web et ses serveurs MCP");
    expect(french).not.toMatch(/proxy/i);
  });

  it("says 'may' in the 3 of 3 sentence when the legs are assumed", async () => {
    const words = await shown({
      ...quiet,
      tools: { preset: "default", active: "unknown-until-start" },
      trifecta: { privateData: true, untrustedContent: true, exfiltration: true },
    });
    expect(words).toContain(
      "3 of 3: this agent may read private data, read untrusted content and send data out.",
    );
  });

  it("gives no removal advice below 3 of 3", async () => {
    expect(await shown(quiet)).not.toContain("To remove a leg");
  });

  it("notes that a running thread keeps the settings it started with (M11R47)", async () => {
    expect(await shown(quiet)).toContain(
      "A running thread keeps the sandbox and network settings it started with until its run ends.",
    );
  });
});

describe("fix round 1 (m2): the exfiltration leg says how, by sandbox and egress", () => {
  const exfil = { ...quiet.trifecta, exfiltration: true };
  it("says the shell is unrestricted when the sandbox is off, not 'any host the proxy lets it reach'", async () => {
    const words = await shown({
      ...quiet,
      sandbox: { required: false, effective: "off", network: true },
      egress: "off",
      trifecta: exfil,
    });
    expect(words).toContain("This agent can send data out: its shell is unrestricted");
    expect(words).not.toContain("the proxy lets it reach");
  });

  it("says the shell has no network when the sandbox is on and its network is off", async () => {
    const words = await shown({
      ...quiet,
      sandbox: { required: true, effective: "on", network: false },
      egress: "off",
      trifecta: exfil,
    });
    expect(words).toContain("its shell has no network");
    expect(words).not.toContain("the proxy lets it reach");
  });

  it("keeps the proxy sentence when the egress is proxied", async () => {
    expect(await shown({ ...quiet, trifecta: exfil })).toContain("any host the proxy lets it reach");
  });

  it("does not call an unavailable sandbox unrestricted: the shell cannot start", async () => {
    const words = await shown({
      ...quiet,
      sandbox: { required: true, effective: "unavailable", network: true },
      egress: "off",
      trifecta: exfil,
    });
    expect(words).toContain("its shell cannot start");
    expect(words).not.toContain("unrestricted");
  });

  it("does not name the proxy in the 3 of 3 advice for an unsandboxed shell", async () => {
    const all = { privateData: true, untrustedContent: true, exfiltration: true };
    const open = await shown({
      ...quiet,
      sandbox: { required: false, effective: "off", network: true },
      egress: "off",
      trifecta: all,
    });
    expect(open).toContain("Sending data out: turn the sandbox on");
    expect(open).not.toContain("the proxy lets it reach");
    const proxied = await shown({ ...quiet, trifecta: all });
    expect(proxied).toContain("Sending data out: turn the sandbox network off");
  });

  it("writes the new French copy with vous", async () => {
    setLocale("fr");
    const words = await shown({
      ...quiet,
      sandbox: { required: false, effective: "off", network: true },
      egress: "off",
      trifecta: exfil,
    });
    expect(words).toContain("n'est pas restreint");
    expect(words).toContain("vous");
  });
});

describe("the rest of the sheet", () => {
  it("lists the live tools, or says they are unknown until the thread starts", async () => {
    expect(await shown(quiet)).toContain("read, bash, edit, write");
    expect(await shown({ ...quiet, tools: { preset: "chat", active: "unknown-until-start" } })).toContain(
      "listed once its thread has started",
    );
  });

  it("names the owner's list for hosts, a list of hosts, and any host", async () => {
    expect(await shown({ ...quiet, hosts: "owner's list" })).toContain(
      "Hosts: the list you set for all agents",
    );
    expect(await shown(quiet)).toContain("Hosts: api.github.com, *.npmjs.org");
    expect(await shown({ ...quiet, hosts: "any" })).toContain(
      "Hosts: none for its shell (no list is set); its URL tools may reach any host",
    );
  });

  it("shows the sandbox, the egress line, the trusted sources and the trusted-autonomy switch", async () => {
    const words = await shown({
      ...quiet,
      trustedSources: ["docs.example.com"],
      trustedAutonomy: true,
    });
    expect(words).toContain("Sandbox: on");
    expect(words).toContain("Egress: proxied");
    expect(words).toContain("Trusted sources: docs.example.com");
    expect(words).toContain("Trusted autonomy: on");
    const off = await shown({
      ...quiet,
      sandbox: { required: true, effective: "on", network: false },
      egress: "off",
    });
    expect(off).toContain("Egress: off");
    expect(off).toContain("Trusted sources: none");
    expect(off).toContain("Trusted autonomy: off");
  });

  it("says when the sandbox is off or unavailable, in plain words", async () => {
    expect(
      await shown({ ...quiet, sandbox: { required: false, effective: "off", network: true } }),
    ).toContain("Sandbox: off. Its shell runs as you");
    expect(
      await shown({ ...quiet, sandbox: { required: true, effective: "unavailable", network: true } }),
    ).toContain("required but not available");
  });

  it("lists the vault names, the triggers and the blocked commands, never a value", async () => {
    const words = await shown(quiet);
    expect(words).toContain("Secrets in its vault: GITHUB_TOKEN");
    expect(words).toContain("Nightly digest");
    expect(words).toContain("Blocked commands: 3 rules");
  });

  it("is written in French too", async () => {
    setLocale("fr");
    const words = await shown({
      ...quiet,
      trifecta: { privateData: true, untrustedContent: true, exfiltration: true },
    });
    expect(words).toContain("3 sur 3");
    expect(words).toContain("peut lire des données privées");
  });
});
