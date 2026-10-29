import { describe, expect, it } from "vitest";
import { renderUnit } from "./unit.ts";
import { parseUnit } from "./unit-read.ts";

const NODE = "/usr/local/lib/nodejs/bin/node";
const MAIN = "/home/u/.local/share/pap/current/app/apps/daemon/dist/main.js";
const render = (extra: { port?: number; home?: string } = {}) =>
  renderUnit({ node: NODE, main: MAIN, stopTimeoutSec: 40, ...extra });

describe("parseUnit round trip over renderUnit", () => {
  it.each([
    [{}, null, null],
    [{ port: 7800 }, 7800, null],
    [{ home: "/home/u/.pap" }, null, "/home/u/.pap"],
    [{ port: 7800, home: "/home/u/.pap-x" }, 7800, "/home/u/.pap-x"],
  ])("%j", (extra, port, home) => {
    expect(parseUnit(render(extra))).toEqual({
      node: NODE,
      main: MAIN,
      port,
      previewPort: null,
      host: null,
      home,
      env: {
        PATH: "/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/bin:/bin",
        ...(home === null ? {} : { PAP_HOME: home }),
      },
      tls: false,
      insecureHttp: false,
    });
  });
});

describe("parseUnit refuses what it cannot read faithfully", () => {
  it.each(["EnvironmentFile=/home/u/pap.env", "EnvironmentFile=-/home/u/pap.env"])(
    "%s may set PAP_HOME out of sight, so the unit is unreadable",
    (line) => {
      expect(parseUnit(`${render({ home: "/home/u/.pap" })}\n${line}\n`)).toBeNull();
    },
  );

  it("an empty PAP_HOME= is unreadable, not a home of ''", () => {
    expect(parseUnit(`${render()}\nEnvironment=PAP_HOME=\n`)).toBeNull();
  });
});

describe("parseUnit drop-ins and flags", () => {
  it("an empty ExecStart= resets and the later one wins: tls, host, the later argv", () => {
    const text = [
      render({ port: 7800 }),
      "# /home/u/.config/systemd/user/pap.service.d/override.conf",
      "[Service]",
      "ExecStart=",
      `ExecStart=${NODE} --disable-warning=ExperimentalWarning ${MAIN} serve --port 7900 --host 192.0.2.1 --tls-cert /x --tls-key /y`,
    ].join("\n");
    const parsed = parseUnit(text);
    expect(parsed).toMatchObject({ port: 7900, host: "192.0.2.1", tls: true, insecureHttp: false });
  });
  it("a reset with nothing after it leaves no ExecStart: null", () => {
    expect(parseUnit(`${render()}\n[Service]\nExecStart=\n`)).toBeNull();
  });
  it("--insecure-http", () => {
    const text = render().replace("serve", "serve --insecure-http --host 192.0.2.5");
    expect(parseUnit(text)).toMatchObject({ insecureHttp: true, host: "192.0.2.5", tls: false });
  });
  it("--flag=value forms are read too", () => {
    const text = render().replace("serve", "serve --port=7811 --host=localhost");
    expect(parseUnit(text)).toMatchObject({ port: 7811, host: "localhost" });
  });
  it("Environment= lines merge in order, several assignments on one line, an empty one resets", () => {
    const text = [render(), "Environment=A=1 B=2", "Environment=A=3"].join("\n");
    expect(parseUnit(text)?.env).toMatchObject({ A: "3", B: "2" });
    const reset = [render({ home: "/h/p" }), "Environment=", "Environment=Z=9"].join("\n");
    expect(parseUnit(reset)).toMatchObject({ home: null, env: { Z: "9" } });
  });
});

describe("parseUnit refuses an Environment= it cannot read (null, never a silent home)", () => {
  it.each([
    'Environment="PAP_HOME=/x"',
    'Environment=PAP_HOME="/x"',
    "Environment=PAP_HOME='/x'",
    "Environment=PAP_HOME",
    "Environment=PAP_HOME=/x$Y",
    "Environment=PAP_HOME=/x\\ y",
  ])("%s", (line) => {
    expect(parseUnit(`${render()}\n${line}\n`)).toBeNull();
  });
  it("a readable PAP_HOME in the same shape still works", () => {
    expect(parseUnit(`${render()}\nEnvironment=PAP_HOME=/x\n`)?.home).toBe("/x");
  });
});

describe("parseUnit refuses what is not ours (null)", () => {
  it("no ExecStart", () => {
    expect(parseUnit("[Service]\nRestart=on-failure\n")).toBeNull();
    expect(parseUnit("")).toBeNull();
  });
  it.each([
    "/usr/bin/node a.js; rm -rf x serve",
    "/usr/bin/node $HOME/a.js serve",
    "/usr/bin/node /a/b c.js serve",
    '/usr/bin/node "/a/b.js" serve',
    "/usr/bin/node /a/../b.js serve",
    "node /a/b.js serve",
    "/usr/bin/node /a/b.js start",
    "/usr/bin/node /a/b.js",
    "-/usr/bin/node /a/b.js serve",
  ])("ExecStart=%s", (exec) => {
    expect(parseUnit(`[Service]\nExecStart=${exec}\n`)).toBeNull();
  });
  it("reads --preview-port, spaced or with =, and null without it", () => {
    expect(parseUnit(render())).toMatchObject({ previewPort: null });
    expect(parseUnit(render().replace("serve", "serve --preview-port 9001"))).toMatchObject({
      previewPort: 9001,
    });
    expect(parseUnit(render().replace("serve", "serve --preview-port=9002"))).toMatchObject({
      previewPort: 9002,
    });
  });
  it("a bad port, a bad host or an unsafe tls path", () => {
    for (const flags of [
      "--port 0",
      "--port 70000",
      "--port x",
      "--host a;b",
      "--host",
      "--tls-cert /a$b",
      "--preview-port 0",
      "--preview-port x",
      "--preview-port",
    ]) {
      expect(parseUnit(render().replace("serve", `serve ${flags}`))).toBeNull();
    }
  });
});
