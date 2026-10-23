import { describe, expect, it } from "vitest";
import { STOP_DEADLINE_MS } from "../../shutdown.ts";
import { readJournal, renderUnit, safePath, unitStopTimeoutSec } from "./unit.ts";

const NODE = "/usr/local/lib/nodejs/bin/node";
const MAIN = "/home/u/.local/share/pap/current/app/apps/daemon/dist/main.js";

describe("renderUnit", () => {
  it("renders exactly this unit", () => {
    expect(renderUnit({ node: NODE, main: MAIN, port: 7800, home: "/home/u/.pap", stopTimeoutSec: 40 })).toBe(
      [
        "[Unit]",
        "Description=pap (self-hosted agentic platform)",
        "StartLimitIntervalSec=120",
        "StartLimitBurst=5",
        "",
        "[Service]",
        `ExecStart=${NODE} --disable-warning=ExperimentalWarning ${MAIN} serve --port 7800`,
        "Environment=PATH=/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/bin:/bin",
        "Environment=PAP_HOME=/home/u/.pap",
        "NoNewPrivileges=yes",
        "RestrictSUIDSGID=yes",
        "LockPersonality=yes",
        "Restart=on-failure",
        "RestartSec=5",
        "KillMode=mixed",
        "TimeoutStopSec=40",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
  });
  it.each([0, 3601, 1.5, -1, Number.NaN])("refuses stopTimeoutSec %s", (stopTimeoutSec) => {
    expect(() => renderUnit({ node: NODE, main: MAIN, stopTimeoutSec })).toThrow(/stopTimeoutSec/);
  });
  it("renders the fixed template", () => {
    const text = renderUnit({ node: NODE, main: MAIN, port: 7800, home: "/home/u/.pap", stopTimeoutSec: 40 });
    expect(text).toContain(
      `ExecStart=${NODE} --disable-warning=ExperimentalWarning ${MAIN} serve --port 7800\n`,
    );
    expect(text).toContain("Environment=PATH=/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/bin:/bin\n");
    expect(text).toContain("Environment=PAP_HOME=/home/u/.pap\n");
    expect(text).not.toContain("UMask");
    expect(text).toContain("TimeoutStopSec=40\n");
    for (const line of [
      "NoNewPrivileges=yes",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "KillMode=mixed",
      "StartLimitIntervalSec=120",
      "StartLimitBurst=5",
    ])
      expect(text).toContain(`${line}\n`);
    expect(text).toContain("WantedBy=default.target\n");
  });
  it("never exposes the daemon beyond loopback", () => {
    const text = renderUnit({ node: NODE, main: MAIN, stopTimeoutSec: 40 });
    for (const flag of ["--host", "--insecure-http", "--tls-cert", "--tls-key"])
      expect(text).not.toContain(flag);
    expect(text).not.toContain("PAP_HOME");
    expect(text).not.toContain("--port");
  });
  it("never takes the directives that would break the agents' sandbox or carry a secret", () => {
    const text = renderUnit({ node: NODE, main: MAIN, home: "/home/u/.pap", stopTimeoutSec: 40 });
    for (const forbidden of [
      "ProtectHome",
      "PrivateTmp",
      "RestrictNamespaces",
      "PrivateUsers",
      "SystemCallFilter",
      "_KEY",
      "TOKEN",
    ])
      expect(text).not.toContain(forbidden);
  });
  it("keeps the PATH entries absolute and free of duplicates", () => {
    expect(renderUnit({ node: "/usr/bin/node", main: MAIN, stopTimeoutSec: 40 })).toContain(
      "Environment=PATH=/usr/bin:/usr/local/bin:/bin\n",
    );
  });
  it("waits longer than the daemon's own stop deadline (M6R4)", () => {
    expect(unitStopTimeoutSec() * 1000).toBeGreaterThan(STOP_DEADLINE_MS);
  });
  it.each([0, 65_536, 1.5, -1, Number.NaN])("refuses port %s", (port) => {
    expect(() => renderUnit({ node: NODE, main: MAIN, port, stopTimeoutSec: 40 })).toThrow(/--port/);
  });
});

describe("safePath", () => {
  it.each([
    "relative/path",
    "",
    "/with space/node",
    "/with%h/node",
    "/with$HOME/node",
    '/with"quote/node',
    "/with'quote/node",
    "/with\\backslash",
    "/semi;colon",
    "/new\nline",
    "/new\rline",
    "/tab\tin",
    "/a/../b",
    "/a//b",
    "/",
    "/a/b/",
    "/a/./b",
    "/a/.",
    "/café/node",
    `/zero${String.fromCharCode(0x200b)}width`,
    `/${"a".repeat(1100)}`,
  ])("refuses %j", (value) => {
    expect(() => safePath("--main", value)).toThrow(/--main must be an absolute path/);
  });
  it("accepts a plain home path", () => {
    expect(safePath("--home", "/home/u-1/.local/share/pap_2/a+b@c.d")).toBe(
      "/home/u-1/.local/share/pap_2/a+b@c.d",
    );
  });
  it("cannot smuggle a second directive through any renderUnit input", () => {
    const evil = "/x\nExecStartPre=/bin/sh";
    for (const input of [
      { node: evil, main: MAIN },
      { node: NODE, main: evil },
      { node: NODE, main: MAIN, home: evil },
    ])
      expect(() => renderUnit({ ...input, stopTimeoutSec: 40 })).toThrow();
  });
});

describe("readJournal", () => {
  const line = (url: string) => `{"time":"t","level":"info","msg":"setup_url","url":"${url}","hint":"h"}`;
  const listening = '{"time":"t","level":"info","msg":"listening","url":"http://localhost:7777","port":7777}';
  it("returns the last setup_url line and whether the daemon listened", () => {
    const text = [
      line("http://localhost:7777/setup#t=old"),
      listening,
      line("http://localhost:7777/setup#t=new"),
    ].join("\n");
    expect(readJournal(text)).toEqual({ listening: true, setupUrl: "http://localhost:7777/setup#t=new" });
  });
  it("a start that never logged listening is not listening", () => {
    expect(readJournal(line("http://localhost:7777/setup#t=a"))).toEqual({
      listening: false,
      setupUrl: "http://localhost:7777/setup#t=a",
    });
    expect(readJournal('{"msg":"other"}')).toEqual({ listening: false, setupUrl: null });
  });
  it("ignores a setup_url longer than 2048 characters", () => {
    expect(readJournal(line(`http://localhost:7777/${"a".repeat(2048)}`)).setupUrl).toBeNull();
  });
  it("listening without a url is the owner-exists case", () => {
    expect(readJournal(listening)).toEqual({ listening: true, setupUrl: null });
  });
  it.each([
    "https://localhost:7777/x",
    "http://evil.example/x",
    "http://192.168.1.2:7777/x",
    "javascript:alert(1)",
    "not a url",
  ])("ignores %s", (url) => expect(readJournal(line(url)).setupUrl).toBeNull());
  it("ignores torn and foreign lines and answers nothing for an empty journal", () => {
    expect(readJournal('{"msg":"setup_url","url":"http://local')).toEqual({
      listening: false,
      setupUrl: null,
    });
    expect(readJournal('{"msg":"listening')).toEqual({ listening: false, setupUrl: null });
    expect(readJournal("")).toEqual({ listening: false, setupUrl: null });
    expect(readJournal('{"msg":"other","url":"http://localhost:1/"}')).toEqual({
      listening: false,
      setupUrl: null,
    });
  });
});

describe("readJournal with an installed port", () => {
  const setup = (port: number) => `{"msg":"setup_url","url":"http://localhost:${port}/setup#token=t"}`;
  it("accepts a setup URL whose port is the installed one", () => {
    expect(readJournal(setup(7790), 7790).setupUrl).toBe("http://localhost:7790/setup#token=t");
  });
  it("ignores a setup URL of another port (a stale start of another install)", () => {
    expect(readJournal(setup(7777), 7790).setupUrl).toBeNull();
  });
  it("takes any loopback port when none is given", () => {
    expect(readJournal(setup(7777)).setupUrl).toBe("http://localhost:7777/setup#token=t");
  });
});
