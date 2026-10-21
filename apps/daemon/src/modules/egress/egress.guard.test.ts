import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createEgress, type Egress } from "./index.ts";
import { connectLine, denyOf, exchange, getLine, scopeOf } from "./testing/bed.ts";

/** Every attempt at a real TCP connection to a host and port: a mutation of the refusal rules must fail here, not dial out (W5-R50). */
const dialled = vi.hoisted(() => [] as unknown[]);
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  const guarded = (...args: Parameters<typeof actual.connect>) => {
    const [first] = args;
    // The bed reaches the proxy through its unix socket; only a host-and-port connection is the production connector's.
    if (typeof first === "object" && first !== null && "host" in first) {
      dialled.push(first);
      throw new Error("no real connection in a test");
    }
    return actual.connect(...args);
  };
  return { ...actual, connect: guarded, default: { ...actual, connect: guarded } };
});

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "rebind.example.com")
      return [
        { address: "203.0.113.7", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    if (host === "metadata.example.com") return [{ address: "169.254.169.254", family: 4 }];
    if (host === "lan.example.com") return [{ address: "::ffff:192.168.1.5", family: 6 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  },
}));

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}
const production = (dir: string): string[] =>
  [...walk(dir)].filter(
    (path) => !path.endsWith(".test.ts") && !relative(SRC, path).split("/").includes("testing"),
  );

let tmp: string;
let egress: Egress;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "egg-"));
  egress = createEgress({
    clock: createFakeClock(),
    logger: captureLogger().logger,
    papHome: tmp,
    runtimeDir: undefined,
    probe: async () => ({ usable: true, python: "/usr/bin/python3.14", reason: null }),
  });
});
afterEach(async () => {
  await egress.dropSession("s1");
  rmSync(tmp, { recursive: true, force: true });
});

describe("production refuses loopback, private and metadata addresses (M11R244)", () => {
  it("whatever the scope allows, by literal or by name", async () => {
    await egress.bootClean();
    const opened = await egress.openCommand(
      scopeOf({ hosts: null, trustedSources: ["127.0.0.1"], grants: () => ["::1"] }),
    );
    if (!("socket" in opened)) throw new Error("not opened");
    for (const target of ["127.0.0.1:443", "[::1]:443", "169.254.169.254:443", "[::ffff:7f00:1]:443"]) {
      expect(denyOf(await exchange(opened.socket, connectLine(target)))).toBe("ip_literal");
    }
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
      expect(denyOf(await exchange(opened.socket, getLine(url)))).toBe("ip_literal");
    }
    for (const name of ["rebind.example.com", "metadata.example.com", "lan.example.com"]) {
      expect(denyOf(await exchange(opened.socket, connectLine(`${name}:443`)))).toBe("blocked_ip");
      expect(denyOf(await exchange(opened.socket, getLine(`http://${name}/`)))).toBe("blocked_ip");
    }
    expect(denyOf(await exchange(opened.socket, connectLine("gone.example.com:443")))).toBe("dns_failed");
    expect(dialled).toEqual([]);
  });
});

describe("the test override stays in tests", () => {
  it("no production file imports egress/testing or any testing folder from this module", () => {
    const offenders = production(join(SRC)).filter((path) =>
      /from\s+["'][^"']*egress\/testing\//.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
    const inside = production(HERE).filter((path) => /["']\.\/testing\//.test(readFileSync(path, "utf8")));
    expect(inside).toEqual([]);
  });

  it("nothing outside modules/egress references createProxy", () => {
    const outside = production(SRC).filter(
      (path) => !path.startsWith(HERE) && /\bcreateProxy\b/.test(readFileSync(path, "utf8")),
    );
    expect(outside).toEqual([]);
  });

  it("only the composition passes the VM address policy to the VM listener", () => {
    const users = production(SRC)
      .filter((path) => /\bvmAddressRefused\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();
    expect(users).toEqual([
      "compose-agents-vm-proxy.ts",
      "modules/egress/index.ts",
      "modules/egress/vm-address.ts",
      "modules/egress/vm-judge.ts",
    ]);
  });

  it("the module (outside testing/) reads no environment variable", () => {
    const files = production(HERE);
    expect(files.length).toBeGreaterThan(5);
    const readers = files.filter((path) =>
      /process\.env|process\[["']env["']\]/.test(readFileSync(path, "utf8")),
    );
    expect(readers).toEqual([]);
  });

  it("index.ts passes the real resolver, deny list and connector, and nothing else", () => {
    const source = readFileSync(join(HERE, "index.ts"), "utf8");
    expect(source).toMatch(/denies: blockedStrict,/);
    expect(source).toMatch(/node:dns\/promises/);
    expect(source).not.toMatch(/loopback|bed\.ts/);
  });
});
