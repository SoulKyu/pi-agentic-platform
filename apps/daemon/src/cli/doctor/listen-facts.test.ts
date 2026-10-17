import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../kernel/config.ts";
import { selfSignedCertificate } from "../../testing/self-signed.ts";
import type { ParsedUnit } from "../service/unit-read.ts";
import { listenFacts } from "./listen-facts.ts";

let dir: string;
let cert: string;
let key: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-listen-"));
  ({ cert, key } = selfSignedCertificate(dir));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const unit = (over: Partial<ParsedUnit> = {}): ParsedUnit => ({
  node: "/n",
  main: "/m",
  port: null,
  host: null,
  home: null,
  env: {},
  tls: false,
  insecureHttp: false,
  ...over,
});

/** The argv `serve` receives for a unit, as `parseUnit` read it. */
const argvOf = (u: ParsedUnit | null): string[] => [
  ...(u?.port == null ? [] : ["--port", String(u.port)]),
  ...(u?.host == null ? [] : ["--host", u.host]),
  ...(u?.tls ? ["--tls-cert", cert, "--tls-key", key] : []),
  ...(u?.insecureHttp ? ["--insecure-http"] : []),
];

function real(u: ParsedUnit | null, shell: NodeJS.ProcessEnv) {
  const config = loadConfig({
    argv: argvOf(u),
    env: u === null ? shell : u.env,
    cwd: dir,
    homedir: "/home/u",
    totalMemMb: 16_384,
    piHostEntry: "/x/main.js",
    piHostExecArgv: [],
    staticRoot: null,
  });
  return { publicOrigin: config.publicOrigin, tls: config.tls !== null, insecureHttp: config.insecureHttp };
}

const cases: Array<[string, ParsedUnit | null, NodeJS.ProcessEnv]> = [
  ["default unit", unit(), {}],
  ["no unit and an empty environment", null, {}],
  ["a LAN host", unit({ host: "192.0.2.1" }), {}],
  ["a LAN host and a port", unit({ host: "192.0.2.1", port: 7791 }), {}],
  ["a wildcard host", unit({ host: "0.0.0.0", port: 7800 }), {}],
  ["an IPv6 loopback", unit({ host: "::1" }), {}],
  ["a bracketed IPv6 address", unit({ host: "[2001:db8::1]" }), {}],
  ["a mixed-case host name", unit({ host: "Pap.Example.NET" }), {}],
  ["--tls-cert", unit({ tls: true, host: "192.0.2.1" }), {}],
  ["--tls-cert on the default host", unit({ tls: true }), {}],
  [
    "PAP_PUBLIC_ORIGIN in the unit environment",
    unit({ env: { PAP_PUBLIC_ORIGIN: "https://pap.example" } }),
    {},
  ],
  [
    "a path and credentials in PAP_PUBLIC_ORIGIN",
    unit({ env: { PAP_PUBLIC_ORIGIN: "https://u:p@pap.example:8443/x" } }),
    {},
  ],
  ["PAP_PUBLIC_ORIGIN only in the shell, no unit", null, { PAP_PUBLIC_ORIGIN: "https://pap.example" }],
  ["a shell origin is ignored when a unit exists", unit(), { PAP_PUBLIC_ORIGIN: "https://shell.example" }],
  ["an empty PAP_PUBLIC_ORIGIN", unit({ env: { PAP_PUBLIC_ORIGIN: "" } }), {}],
  ["a drop-in --insecure-http", unit({ insecureHttp: true, host: "192.0.2.5" }), {}],
];

describe("listenFacts derives like loadConfig", () => {
  it.each(cases)("%s", (_name, u, shell) => {
    expect(listenFacts(u, shell)).toEqual(real(u, shell));
  });

  it("a PAP_PUBLIC_ORIGIN the daemon would refuse falls back to the listen address instead of throwing", () => {
    expect(listenFacts(unit({ env: { PAP_PUBLIC_ORIGIN: "not an origin" } }), {})).toEqual({
      publicOrigin: "http://localhost:7777",
      tls: false,
      insecureHttp: false,
    });
  });

  it("is pure: the inputs are not changed", () => {
    const u = unit({ env: { PAP_PUBLIC_ORIGIN: "https://pap.example" } });
    const before = JSON.stringify(u);
    listenFacts(u, {});
    expect(JSON.stringify(u)).toBe(before);
  });
});
