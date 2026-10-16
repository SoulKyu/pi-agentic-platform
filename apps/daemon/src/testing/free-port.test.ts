import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freePort } from "./free-port.ts";

const [EPHEMERAL_LOW, EPHEMERAL_HIGH] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
  .trim()
  .split(/\s+/)
  .map(Number) as [number, number];

describe("freePort", () => {
  it("stays out of the kernel's ephemeral range, where a concurrent listen(0) or outgoing connection takes a released port", async () => {
    const ports = await Promise.all(Array.from({ length: 50 }, () => freePort()));
    for (const port of ports) expect(port < EPHEMERAL_LOW || port > EPHEMERAL_HIGH).toBe(true);
  });

  it("never hands out the owner's preview or pi-web ports, nor the same port twice", async () => {
    const ports = await Promise.all(Array.from({ length: 200 }, () => freePort()));
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).not.toContain(7777);
    expect(ports).not.toContain(30141);
  });
});
