import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AGENT_NET, type ProjectView } from "@pap/contracts";
import { type KataBed, LONG_MS, skipKata, startKataBed, vmsOf } from "../../testing/kata-bed.ts";
import {
  appCommand,
  b64,
  boxOfAgent,
  helpersOf,
  hexPort,
  sandboxOf,
  scanGuest,
  servicesOf,
  startService,
  withMarker,
} from "../../testing/kata-preview.ts";
import { bodyOf, previewPortOf, through } from "../../testing/preview-bed.ts";

/*
 * UX-2 T11, the previews on the real stack: what only a real Kata VM, a real bwrap as guest root and a real `nsenter` can prove.
 * Written in the lane, run by the controller after the merge and `sudo pap vm setup`, before the push (UX2-R37, R75):
 *   CI=1 pnpm vitest run --project kata apps/daemon/src/modules/agent-vm/preview.kata.int.test.ts
 * Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1. A failure of a security case blocks the push (R75):
 * the capabilities and read-only root; no network and the namespace entry; port ownership; the stop. The WebSocket case alone is
 * a follow-up. Ports are fixed: each VM has a network of its own, and no test names a public host.
 * Not a proof: "the helper dies when the VM stops". The guest is gone afterwards, so the case only shows a helper before the stop
 * and no VM, no service and no helper after the new start; it cannot observe the helper's own death.
 */
const skip = skipKata();
let bed: KataBed | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
});

const PORT = {
  caps: 28101,
  site: 28102,
  plain: 28103,
  killme: 28104,
  stopme: 28105,
  doomed: 28106,
  held: 28107,
  echo: 28108,
};
const mark = (name: string): string => `kata-svc-${name}`;
const CAP_EFF_SHELL = "00000000000000fb";

describe.skipIf(skip)("a box session's service on the real stack", () => {
  let project: ProjectView;
  let sessionId: string;
  const box = () => ({ kind: "project", id: project.id }) as const;
  beforeAll(async () => {
    bed = await startKataBed({ probe: false });
    ({ project } = await bed.call<{ project: ProjectView }>("projects.create", { name: "Kata preview" }));
    await bed.call("projects.startBox", { projectId: project.id });
    sessionId = (await bed.call<{ sessionId: string }>("sessions.create", { cwd: project.root })).sessionId;
  }, LONG_MS);
  afterAll(async () => {
    try {
      // project is unset when the first hook failed before the project was made.
      const ref = project === undefined ? undefined : ({ kind: "project", id: project.id } as const);
      if (ref !== undefined) {
        await bed?.vmd.request({ op: "vm.stop", box: ref, taskKey: null }).catch(() => undefined);
        await bed?.vmd
          .request({ op: "disk.delete", box: ref, taskKey: null, purge: true })
          .catch(() => undefined);
      }
    } finally {
      await bed?.stop();
      bed = undefined;
    }
  }, LONG_MS);

  it(
    "a box session's service runs in bwrap with the shell's seven capabilities and a read-only root",
    async () => {
      const prelude =
        "grep CapEff /proc/self/status > cap.txt; " +
        "if touch /usr/pap-preview-x 2>/dev/null; then echo touched > touch.txt; else echo failed > touch.txt; fi; ";
      const view = await startService(bed as KataBed, box(), sessionId, {
        name: "caps",
        port: PORT.caps,
        command: appCommand(PORT.caps, mark("caps"), prelude),
      });
      expect(view).toMatchObject({ state: "running", reason: null, network: true });
      const read = (name: string) =>
        (bed as KataBed).call<{ text: string }>("files.read", { path: `${project.root}/${name}` });
      expect((await read("cap.txt")).text).toMatch(new RegExp(`^CapEff:\\s+${CAP_EFF_SHELL}$`));
      expect((await read("touch.txt")).text.trim()).toBe("failed");
    },
    LONG_MS,
  );

  it(
    "relays a request from the untrusted listener to a real service: 200, the service CSP, no pap cookie",
    async () => {
      const b = bed as KataBed;
      await startService(b, box(), sessionId, {
        name: "site",
        port: PORT.site,
        command: appCommand(PORT.site, mark("site")),
      });
      const opened = await b.call<{ url: string }>("previews.open", { box: box(), name: "site" });
      const reply = await through(await previewPortOf(b.t), opened.url, "page?x=1", {
        cookie: "pap_session=SECRET",
        authorization: "Bearer SECRET",
      });
      expect(reply.status).toBe(200);
      expect(String(reply.headers["content-security-policy"])).toMatch(/^sandbox allow-scripts /);
      expect(bodyOf(reply)).toMatchObject({ cookie: null, url: "/page?x=1" });
      expect(reply.headers["set-cookie"]).toBeUndefined();
      expect(reply.body).not.toContain("SECRET");
      expect((JSON.parse(reply.body) as { auth: string | null }).auth).toBeNull();
    },
    LONG_MS,
  );
});

describe.skipIf(skip)("a service of an agent without network on the real stack", () => {
  let agentId: string;
  let sessionId: string;
  const scan = (before?: string) => scanGuest(bed as KataBed, agentId, sessionId, before);
  const probe = (cmd: string) => (bed as KataBed).probe(agentId, sessionId, cmd);
  const start = (name: keyof typeof PORT, prelude?: string) =>
    startService(bed as KataBed, boxOfAgent(agentId), sessionId, {
      name,
      port: PORT[name],
      command: appCommand(PORT[name], mark(name), prelude),
    });
  beforeAll(async () => {
    bed = await startKataBed();
    agentId = await bed.createAgent({ name: "Quiet", sandbox: { required: true, network: false } });
    sessionId = await bed.openThread(agentId);
  }, LONG_MS);
  afterAll(async () => {
    await bed?.stop();
    bed = undefined;
  }, LONG_MS);

  it(
    "nsenter is in the base image",
    async () => {
      const out = await probe("ls -l /usr/bin/nsenter; /usr/bin/nsenter --version; dpkg-query -W util-linux");
      expect(out).toContain("/usr/bin/nsenter");
      expect(out).toMatch(/nsenter from util-linux/);
      expect(out).toMatch(/^util-linux\t/m);
    },
    LONG_MS,
  );

  it(
    "a service without network reaches its own port through the namespace helper and nothing on the bridge",
    async () => {
      const b = bed as KataBed;
      const dial = [
        "import socket, errno",
        `for host, port in ${JSON.stringify([
          [AGENT_NET.host, AGENT_NET.proxyPort],
          [AGENT_NET.host, AGENT_NET.gatewayPort],
        ])}:`,
        "    s = socket.socket(); s.settimeout(3)",
        "    try: s.connect((host, port)); r = 'OK'",
        "    except socket.timeout: r = 'timeout'",
        "    except OSError as e: r = errno.errorcode.get(e.errno, str(e.errno))",
        "    print('DIAL %s:%d=%s' % (host, port, r))",
      ].join("\n");
      const view = await start("plain", `echo ${b64(dial)} | base64 -d | python3 - > dial.txt 2>&1; `);
      expect(view).toMatchObject({ state: "running", network: false });

      // The preview listener reaches the service's own loopback: only the helper, inside its namespace, can.
      const opened = await b.call<{ url: string }>("previews.open", {
        box: boxOfAgent(agentId),
        name: "plain",
      });
      const reply = await through(await previewPortOf(b.t), opened.url, "hello");
      expect(reply.status).toBe(200);
      expect(bodyOf(reply).url).toBe("/hello");

      const procs = await scan();
      const { outer, service } = sandboxOf(procs, mark("plain"));
      // bwrap started as guest root with the shell's argv, and the sandbox keeps the shell's seven capabilities.
      expect(outer.uid).toBe(0);
      const argv = outer.cmd.split(" ");
      for (const flag of ["--unshare-net", "--unshare-pid", "--die-with-parent"])
        expect(argv).toContain(flag);
      const after = (flag: string): string[] =>
        argv.flatMap((word, index) => (word === flag ? [argv[index + 1] ?? ""] : []));
      expect(after("--cap-drop")).toEqual(["ALL"]);
      expect(after("--cap-add").sort()).toEqual([
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_FSETID",
        "CAP_KILL",
        "CAP_SETGID",
        "CAP_SETUID",
      ]);
      expect(after("--seccomp")).toEqual(["3"]);
      expect(outer.cmd).not.toContain("CAP_SYS_ADMIN");
      expect(service.cap).toBe(CAP_EFF_SHELL);
      expect(service.ns).not.toBe(outer.ns);

      // One helper, in the service's namespace, with the IPC channel (fd 3) and the namespace descriptor (fd 4) across nsenter's exec.
      const helpers = helpersOf(procs);
      expect(helpers).toHaveLength(1);
      const helper = helpers[0] as (typeof helpers)[number];
      expect(helper.ns).toBe(service.ns);
      expect(helper.uid).toBe(0);
      expect(helper.fds).toEqual(expect.arrayContaining(["3", "4"]));
      expect(await probe(`readlink /proc/${helper.pid}/fd/4`)).toContain(service.ns);

      // The sandbox's own tables, read as guest root: it owns its listener, and its namespace gained nothing.
      const tcp = await probe(`cat /proc/${service.pid}/net/tcp`);
      expect(tcp).toMatch(new RegExp(`^\\s*\\d+: 0100007F:${hexPort(PORT.plain)} 00000000:0000 0A `, "m"));
      expect(await probe("cat /proc/1/net/tcp")).not.toMatch(
        new RegExp(`^\\s*\\d+: [0-9A-F]{8}:${hexPort(PORT.plain)} `, "m"),
      );
      const dev = await probe(`cat /proc/${service.pid}/net/dev`);
      expect(
        dev
          .split("\n")
          .filter((line) => line.includes(":") && !line.includes("|"))
          .map((line) => line.split(":")[0]?.trim()),
      ).toEqual(["lo"]);
      const routes = (await probe(`cat /proc/${service.pid}/net/route`)).split("\n");
      expect(routes.filter((line) => /^\w+\t[0-9A-F]{8}\t/.test(line))).toEqual([]);

      // The proxy and the gateway are unreachable from it: the service's own dial failed with no route.
      const dialed = await probe("cat /agent/home/dial.txt");
      expect(dialed).toMatch(new RegExp(`DIAL ${AGENT_NET.host}:${AGENT_NET.proxyPort}=E(NET|HOST)UNREACH`));
      expect(dialed).toMatch(
        new RegExp(`DIAL ${AGENT_NET.host}:${AGENT_NET.gatewayPort}=E(NET|HOST)UNREACH`),
      );
    },
    LONG_MS,
  );

  it(
    "--die-with-parent: SIGTERM to the outer bwrap alone leaves no process of its sandbox",
    async () => {
      await start("killme");
      const { outer } = sandboxOf(await scan(), mark("killme"));
      const after = await scan(`kill -TERM ${outer.pid}; sleep 2`);
      expect(withMarker(after, mark("killme"))).toEqual([]);
      await vi.waitFor(
        async () =>
          expect(
            (await servicesOf(bed as KataBed, boxOfAgent(agentId))).find((s) => s.name === "killme")?.state,
          ).toBe("exited"),
        { timeout: 20_000, interval: 1_000 },
      );
    },
    LONG_MS,
  );

  it(
    "stopping a service leaves no process of its sandbox",
    async () => {
      const b = bed as KataBed;
      await start("stopme");
      expect(withMarker(await scan(), mark("stopme")).length).toBeGreaterThanOrEqual(3);
      await b.call("previews.stop", { box: boxOfAgent(agentId), name: "stopme" });
      // The supervisor signals the outer bwrap only (UX2-R19): after 2 s nothing of the sandbox is left.
      expect(withMarker(await scan("sleep 2"), mark("stopme"))).toEqual([]);
      expect((await servicesOf(b, boxOfAgent(agentId))).find((s) => s.name === "stopme")?.state).toBe(
        "stopped",
      );
    },
    LONG_MS,
  );

  it(
    "stopping the box kills its services and previews.list is empty after a new start",
    async () => {
      const b = bed as KataBed;
      const ref = boxOfAgent(agentId);
      await start("doomed");
      const opened = await b.call<{ url: string }>("previews.open", { box: ref, name: "doomed" });
      const port = await previewPortOf(b.t);
      expect((await through(port, opened.url)).status).toBe(200);
      // Other services of this VM keep their own helpers: the doomed one's is the one in its sandbox's namespace.
      const before = await scan();
      const { service } = sandboxOf(before, mark("doomed"));
      expect(helpersOf(before).filter((helper) => helper.ns === service.ns)).toHaveLength(1);

      // The VM goes, and its service, its sandbox and the namespace helper go with it; the daemon drops the service and its tokens.
      await b.vm.runtime.stop(ref);
      expect(await vmsOf(b.vmd, agentId)).toEqual([]);
      await vi.waitFor(async () => expect(await servicesOf(b, ref)).toEqual([]), {
        timeout: 15_000,
        interval: 500,
      });
      expect((await through(port, opened.url)).status).toBe(404);

      // A new start of the box does not bring the service back.
      b.llm.push({ text: "back" });
      await b.prompt(sessionId, "start again");
      expect(b.starts.length).toBeGreaterThanOrEqual(2);
      expect(await servicesOf(b, ref)).toEqual([]);
      const fresh = await scan();
      expect(withMarker(fresh, mark("doomed"))).toEqual([]);
      expect(helpersOf(fresh)).toEqual([]);
    },
    LONG_MS,
  );
});

describe.skipIf(skip)("a service of an agent with network on the real stack", () => {
  let agentId: string;
  let sessionId: string;
  beforeAll(async () => {
    bed = await startKataBed();
    agentId = await bed.createAgent({
      name: "Netty",
      sandbox: { required: true, network: true },
      allowHosts: ["listed.invalid"],
    });
    sessionId = await bed.openThread(agentId);
  }, LONG_MS);
  afterAll(async () => {
    await bed?.stop();
    bed = undefined;
  }, LONG_MS);

  it(
    "port_not_owned when another service already listens on the port",
    async () => {
      const b = bed as KataBed;
      const ref = boxOfAgent(agentId);
      const holder = await startService(b, ref, sessionId, {
        name: "held",
        port: PORT.held,
        command: appCommand(PORT.held, mark("held")),
      });
      expect(holder).toMatchObject({ state: "running", network: true });
      // The second one never listens: the port answers, but not from its own tree.
      const usurper = await startService(b, ref, sessionId, {
        name: "usurper",
        port: PORT.held,
        command: "sleep 600",
      });
      expect(usurper).toMatchObject({ state: "failed", reason: "port_not_owned" });
      const listed = await servicesOf(b, ref);
      expect(listed.find((service) => service.name === "held")?.state).toBe("running");
    },
    LONG_MS,
  );

  it(
    "a WebSocket echo works through the tunnel and survives 55 s of silence (the gateway ping)",
    async () => {
      const b = bed as KataBed;
      const ref = boxOfAgent(agentId);
      await startService(b, ref, sessionId, {
        name: "echo",
        port: PORT.echo,
        command: appCommand(PORT.echo, mark("echo")),
      });
      const opened = await b.call<{ url: string }>("previews.open", { box: ref, name: "echo" });
      const socket = new WebSocket(
        `ws://127.0.0.1:${await previewPortOf(b.t)}${new URL(opened.url).pathname}ws`,
      );
      try {
        await once(socket, "open");
        const echoed = async (text: string): Promise<string> => {
          const reply = once(socket, "message").then(([data]) => String(data));
          socket.send(text);
          return reply;
        };
        expect(await echoed("hello")).toBe("hello");
        // The gateway pings the guest every 15 s and drops it after three unanswered pings (45 s): a tunnel open for longer lives.
        await sleep(55_000);
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(await echoed("still here")).toBe("still here");
      } finally {
        socket.close();
      }
    },
    LONG_MS,
  );
});
