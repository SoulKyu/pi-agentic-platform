import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NET } from "@pap/contracts";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * Sub-project 2, lane A: the VM's network through the egress proxy, seen from the shell of a real VM (no public host).
 * Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1. Run locally by the controller after `sudo pap vm setup`.
 * Mutants (each run for real):
 *  - the list check dropped in the VM judge: killed by "answers 403 not_listed".
 *  - `--unshare-net` back in `bwrapVmArgv`: killed by "sets the proxy variables" and every dial.
 *  - a DNS failure answered 403 again: killed by "answers 502 resolve for a listed name that does not resolve".
 *  - the address policy skipped for IP entries: killed by "answers 403 blocked_address".
 */
const skip = skipKata();
let bed: KataBed | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  await bed?.stop();
  bed = undefined;
});

const PROXY = `${AGENT_NET.host}:${AGENT_NET.proxyPort}`;
const LISTED = ["listed.invalid", `127.0.0.1:${AGENT_NET.gatewayPort}`];

/** Sends each request head to the proxy over a raw socket and prints `<label> <status> <x-pap-deny> | <first body line>`. */
const proxyScript = (legs: ReadonlyArray<{ label: string; head: string }>): string =>
  [
    "import socket",
    `proxy = (${JSON.stringify(AGENT_NET.host)}, ${AGENT_NET.proxyPort})`,
    `for label, head in ${JSON.stringify(legs.map((l) => [l.label, l.head]))}:`,
    "    s = socket.socket(); s.settimeout(10)",
    "    try:",
    "        s.connect(proxy); s.sendall(head.encode())",
    "        data = b''",
    "        while True:",
    "            chunk = s.recv(4096)",
    "            if not chunk: break",
    "            data += chunk",
    "    except OSError as e: data = ('ERR %s' % e).encode()",
    "    text = data.decode('latin1')",
    "    first = text.split('\\r\\n')[0]",
    "    deny = [l.split(':', 1)[1].strip() for l in text.split('\\r\\n') if l.lower().startswith('x-pap-deny:')]",
    "    body = text.split('\\r\\n\\r\\n', 1)[-1].strip().split('\\n')[0]",
    "    print('LEG', label, first, 'deny=' + (deny[0] if deny else '-'), '|', body)",
    "    s.close()",
  ].join("\n");

const plainGet = (host: string, port: number): string =>
  `GET http://${host}:${port}/ HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`;
const connectHead = (host: string, port: number): string =>
  `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;

/** One leg's printed line, or "missing". */
const leg = (out: string, label: string, prefix = "LEG"): string =>
  new RegExp(`^${prefix} ${label} (.*)$`, "m").exec(out)?.[1] ?? "missing";

describe.skipIf(skip)("a VM agent's network through the egress proxy (real Kata)", () => {
  it(
    "answers 403 not_listed, 403 blocked_address and 502 resolve, and sets the proxy variables",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent({
        name: "Netty",
        sandbox: { required: true, network: true },
        allowHosts: LISTED,
      });
      const sessionId = await bed.openThread(agentId);
      const out = await bed.shell(
        agentId,
        sessionId,
        [
          `echo ${Buffer.from(
            proxyScript([
              { label: "unlisted-get", head: plainGet("unlisted.invalid", 80) },
              { label: "unlisted-connect", head: connectHead("unlisted.invalid", 443) },
              { label: "listed-get", head: plainGet("listed.invalid", 80) },
              { label: "listed-connect", head: connectHead("listed.invalid", 443) },
              { label: "loopback", head: plainGet("127.0.0.1", AGENT_NET.gatewayPort) },
              { label: "wrong-port", head: connectHead("listed.invalid", 8443) },
            ]),
          ).toString("base64")} | base64 -d | python3 -`,
          'echo "PROXYVARS HTTP_PROXY=$HTTP_PROXY https_proxy=$https_proxy NODE_USE_ENV_PROXY=$NODE_USE_ENV_PROXY"',
          'echo "NO_PROXY=$NO_PROXY"',
        ].join("; "),
      );
      process.stderr.write(`egress, seen from the shell of a VM:\n${out}\n`);
      // 403 and the reason, for a name that is not on the list (plain HTTP and CONNECT).
      for (const label of ["unlisted-get", "unlisted-connect", "wrong-port"]) {
        expect(leg(out, label), label).toContain("403");
        expect(leg(out, label), label).toContain("deny=not_listed");
      }
      // A listed name passes the list and fails on DNS: a gateway failure, not a refusal.
      for (const label of ["listed-get", "listed-connect"]) {
        expect(leg(out, label), label).toContain("502");
        expect(leg(out, label), label).not.toContain("403");
        expect(leg(out, label), label).toContain("(resolve)");
      }
      // A listed IP entry on an address pap never reaches.
      expect(leg(out, "loopback")).toContain("403");
      expect(leg(out, "loopback")).toContain("blocked_address");
      expect(out).toContain(`HTTP_PROXY=http://${PROXY}`);
      expect(out).toContain(`https_proxy=http://${PROXY}`);
      expect(out).toContain("NODE_USE_ENV_PROXY=1");
      expect(out).toMatch(/NO_PROXY=.*llm\.internal/);
    },
    LONG_MS,
  );

  it(
    "reaches only the proxy: other bridge ports and off-bridge addresses fail",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent({
        name: "Netty",
        allowHosts: LISTED,
        sandbox: { required: true, network: true },
      });
      const sessionId = await bed.openThread(agentId);
      const script = [
        "import socket, errno",
        `for host, port in ${JSON.stringify([
          [AGENT_NET.host, AGENT_NET.proxyPort],
          [AGENT_NET.host, 22],
          ["192.0.2.1", 443],
        ])}:`,
        "    s = socket.socket(); s.settimeout(3)",
        "    try: s.connect((host, port)); r = 'OK'",
        "    except socket.timeout: r = 'timeout'",
        "    except OSError as e: r = errno.errorcode.get(e.errno, str(e.errno))",
        "    print('DIAL %s:%d=%s' % (host, port, r))",
        "    s.close()",
      ].join("\n");
      const out = await bed.shell(
        agentId,
        sessionId,
        `echo ${Buffer.from(script).toString("base64")} | base64 -d | python3 -`,
      );
      expect(out).toContain(`DIAL ${AGENT_NET.host}:${AGENT_NET.proxyPort}=OK`);
      expect(out).not.toContain(`DIAL ${AGENT_NET.host}:22=OK`);
      expect(out).toContain("DIAL 192.0.2.1:443=ENETUNREACH");
    },
    LONG_MS,
  );

  it(
    "shows the shell no PAP_ variable and does not let it read the launch token or the relay key",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent({
        name: "Netty",
        allowHosts: LISTED,
        sandbox: { required: true, network: true },
      });
      const sessionId = await bed.openThread(agentId);
      const token = bed.starts.at(-1)?.token ?? "";
      const relayKey = bed.grants.at(-1)?.relayKey ?? "";
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(relayKey).toMatch(/^[0-9a-f]{64}$/);
      const halves = (value: string): string =>
        `(${JSON.stringify(value.slice(0, 32))} + ${JSON.stringify(value.slice(32))}).encode()`;
      const script = [
        "import os",
        // The launch token and the relay key, each cut in two so no listing of the script holds the whole value.
        `needles = {'token': ${halves(token)}, 'relay key': ${halves(relayKey)}}`,
        "hits = []; seen = 0",
        "for root, dirs, files in os.walk('/'):",
        "    if root in ('/proc', '/sys', '/dev'): dirs[:] = []; continue",
        "    for name in files:",
        "        p = os.path.join(root, name)",
        "        try:",
        "            if os.path.islink(p) or os.path.getsize(p) > 65536: continue",
        "            data = open(p, 'rb').read()",
        "            hits += [n + ' in ' + p for n, t in needles.items() if t in data]",
        "            seen += 1",
        "        except OSError: pass",
        "for p in os.listdir('/proc'):",
        "    if not p.isdigit(): continue",
        "    for f in ('environ', 'cmdline'):",
        "        try:",
        "            data = open('/proc/%s/%s' % (p, f), 'rb').read()",
        "            hits += [n + ' in ' + p + '/' + f for n, t in needles.items() if t in data]",
        "        except OSError: pass",
        "print('TOKENHITS', hits, 'FILES', seen > 100)",
      ].join("\n");
      const out = await bed.shell(
        agentId,
        sessionId,
        [
          'echo "PAPVARS=$(env | grep -c "^PAP_")"',
          `echo ${Buffer.from(script).toString("base64")} | base64 -d | python3 -`,
        ].join("; "),
      );
      expect(out).toContain("PAPVARS=0");
      expect(out).toContain("TOKENHITS [] FILES True");
      expect(out).not.toContain(token);
      expect(out).not.toContain(relayKey);
    },
    LONG_MS,
  );

  // I4: with the network on, the shell shares the VM's address, so the relay's key is the only barrier on 10.213.0.1:7842.
  it(
    "refuses the shell's request to the relay: it has no key, and the relay does not answer for it",
    async () => {
      bed = await startKataBed();
      const agentId = await bed.createAgent({
        name: "Netty",
        allowHosts: LISTED,
        sandbox: { required: true, network: true },
      });
      const sessionId = await bed.openThread(agentId);
      const relayKey = bed.grants.at(-1)?.relayKey ?? "";
      const request = (host: string, extra = ""): string =>
        `POST /scripted/chat/completions HTTP/1.1\r\nHost: ${host}\r\n${extra}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`;
      const script = [
        "import socket",
        `relay = (${JSON.stringify(AGENT_NET.host)}, ${AGENT_NET.relayPort})`,
        `for label, head in ${JSON.stringify([
          ["no-key", request("llm.internal")],
          ["wrong-key", request("llm.internal", "Authorization: Bearer " + "0".repeat(64) + "\r\n")],
          ["claude-no-key", request("claude.internal").replace("/scripted/chat/completions", "/v1/messages")],
        ])}:`,
        "    s = socket.socket(); s.settimeout(10)",
        "    try:",
        "        s.connect(relay); s.sendall(head.encode())",
        "        data = b''",
        "        while True:",
        "            chunk = s.recv(4096)",
        "            if not chunk: break",
        "            data += chunk",
        "    except OSError as e: data = ('ERR %s' % e).encode()",
        "    print('RELAY', label, data.decode('latin1').split('\\r\\n')[0])",
        "    s.close()",
      ].join("\n");
      const out = await bed.shell(
        agentId,
        sessionId,
        `echo ${Buffer.from(script).toString("base64")} | base64 -d | python3 -`,
      );
      for (const label of ["no-key", "wrong-key", "claude-no-key"]) {
        expect(leg(out, label, "RELAY"), label).toContain("403");
        expect(leg(out, label, "RELAY"), label).not.toContain("200");
      }
      expect(relayKey).toMatch(/^[0-9a-f]{64}$/);
      expect(out).not.toContain(relayKey);
    },
    LONG_MS,
  );
});
