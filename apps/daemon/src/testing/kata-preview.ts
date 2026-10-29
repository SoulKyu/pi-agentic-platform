import type { BoxRef, PreviewView } from "@pap/contracts";
import { vi } from "vitest";
import type { KataBed } from "./kata-bed.ts";

// Shared by the previews' Kata journey: a service every case can run (it answers with what it saw and echoes WebSocket text
// frames), the starting of a service through the model's `preview_start` call, and a look at the guest's processes as guest root.

export const b64 = (text: string): string => Buffer.from(text).toString("base64");

/**
 * A node server: every request is answered with what it saw (and a `Set-Cookie`), an upgrade becomes a WebSocket that echoes
 * each short text frame. Plain JavaScript, no dependency: the image has node and nothing else.
 */
const appScript = (port: number): string =>
  [
    "const http=require('http'),crypto=require('crypto');",
    "const s=http.createServer((q,r)=>{r.setHeader('set-cookie','sid=1');r.setHeader('content-type','application/json');",
    "r.end(JSON.stringify({cookie:q.headers.cookie??null,auth:q.headers.authorization??null,url:q.url,prefix:q.headers['x-forwarded-prefix']??null}))});",
    "s.on('upgrade',(q,sock)=>{",
    "sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+",
    "crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\\r\\n\\r\\n');",
    "let buf=Buffer.alloc(0);",
    "sock.on('error',()=>{});",
    "sock.on('data',d=>{buf=Buffer.concat([buf,d]);",
    "while(buf.length>=6){const len=buf[1]&127;if(len>125)return sock.destroy();const need=6+len;if(buf.length<need)return;",
    "const p=Buffer.alloc(len);for(let i=0;i<len;i++)p[i]=buf[6+i]^buf[2+i%4];",
    "const op=buf[0]&15;buf=buf.subarray(need);",
    "if(op===8)return sock.end();",
    "if(op===1)sock.write(Buffer.concat([Buffer.from([0x81,len]),p]));}});});",
    `s.listen(${port},'127.0.0.1');`,
  ].join("");

/**
 * The command of a service: an optional shell prelude, then the app script as the shell's last command. `marker` is an argument of
 * the node process, so its command line (and its sandbox's) names it: a scan of the guest finds the sandbox by it.
 */
export const appCommand = (port: number, marker: string, prelude = ""): string =>
  `${prelude}exec node -e "eval(Buffer.from('${b64(appScript(port))}','base64').toString())" ${marker}`;

/** What the guest's processes show, as guest root: one entry per process of the VM. */
export interface GuestProc {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly cap: string;
  readonly ns: string;
  readonly fds: readonly string[];
  readonly cmd: string;
}

const SCAN = [
  "import os, json",
  "out = []",
  "for d in os.listdir('/proc'):",
  "    if not d.isdigit(): continue",
  "    try:",
  "        cmd = open('/proc/%s/cmdline' % d, 'rb').read().replace(b'\\0', b' ').decode('latin1').strip()",
  "        st = dict(l.split(':', 1) for l in open('/proc/%s/status' % d).read().split('\\n') if ':' in l)",
  "        ns = os.readlink('/proc/%s/ns/net' % d)",
  "        fds = sorted(os.listdir('/proc/%s/fd' % d), key=int)",
  "    except OSError: continue",
  "    out.append(dict(pid=int(d), ppid=int(st['PPid'].split()[0]), uid=int(st['Uid'].split()[0]), cap=st['CapEff'].strip(), ns=ns, fds=fds, cmd=cmd))",
  "print('SCAN ' + json.dumps(out))",
].join("\n");

/** Every process of the VM, seen by the worker (guest root, outside any sandbox), after the shell commands `before` ran. */
export async function scanGuest(
  bed: KataBed,
  agentId: string,
  sessionId: string,
  before = "true",
): Promise<GuestProc[]> {
  const out = await bed.probe(agentId, sessionId, `${before}; echo ${b64(SCAN)} | base64 -d | python3 -`);
  const line = /^SCAN (.*)$/m.exec(out)?.[1];
  if (line === undefined) throw new Error(`the guest scan answered nothing: ${out.slice(0, 300)}`);
  return JSON.parse(line) as GuestProc[];
}

/** The processes whose command line names `marker`: the service's outer bwrap, the sandbox's init, and the service itself. */
export const withMarker = (procs: readonly GuestProc[], marker: string): GuestProc[] =>
  procs.filter((proc) => proc.cmd.includes(marker));

/** The outer bwrap of a marked sandbox (the process the supervisor spawned: its parent does not carry the marker) and the service. */
export function sandboxOf(
  procs: readonly GuestProc[],
  marker: string,
): { outer: GuestProc; service: GuestProc } {
  const marked = withMarker(procs, marker);
  const outer = marked.find(
    (proc) => proc.cmd.includes("bwrap") && !marked.some((other) => other.pid === proc.ppid),
  );
  const service = marked.find((proc) => /^node /.test(proc.cmd));
  if (outer === undefined || service === undefined)
    throw new Error(`no sandbox for ${marker}: ${marked.map((proc) => proc.cmd.slice(0, 80)).join(" | ")}`);
  return { outer, service };
}

/** The namespace helpers of the guest (`ns-dialer`). */
export const helpersOf = (procs: readonly GuestProc[]): GuestProc[] =>
  procs.filter((proc) => proc.cmd.includes("ns-dialer"));

export const boxOfAgent = (agentId: string): BoxRef => ({ kind: "agent", id: agentId });

export async function servicesOf(bed: KataBed, box: BoxRef): Promise<PreviewView[]> {
  return (await bed.call<{ services: PreviewView[] }>("previews.list", { box })).services;
}

/**
 * The model calls `preview_start` (the scripted model, the real worker, the real daemon and guest); resolves with the service the
 * registry holds under `name` once the start has settled.
 */
export async function startService(
  bed: KataBed,
  box: BoxRef,
  sessionId: string,
  spec: { name: string; command: string; port: number },
): Promise<PreviewView> {
  bed.llm.push({ tool: "preview_start", args: spec }, { text: "done" });
  await bed.prompt(sessionId, `preview_start ${spec.name}`);
  return vi.waitFor(
    async () => {
      const found = (await servicesOf(bed, box)).find((service) => service.name === spec.name);
      if (found === undefined) throw new Error(`${spec.name} is not in previews.list`);
      return found;
    },
    { timeout: 30_000, interval: 500 },
  );
}

export const hexPort = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");
