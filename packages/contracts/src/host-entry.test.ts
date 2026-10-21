import { describe, expect, it } from "vitest";
import { entryAllows, entryFor, parseHostEntry, tryParseHostEntry } from "./host-entry.ts";

describe("parseHostEntry", () => {
  it("defaults to ports 80 and 443", () => {
    expect(parseHostEntry("k8s.lan").ports).toEqual([80, 443]);
    expect(parseHostEntry("k8s.lan:6443")).toEqual({
      host: "k8s.lan",
      ip: false,
      wildcard: false,
      ports: [6443],
    });
    expect(parseHostEntry("[FD00::1]:6443")).toEqual({
      host: "fd00::1",
      ip: true,
      wildcard: false,
      ports: [6443],
    });
    expect(parseHostEntry("*.example.com")).toMatchObject({ host: "example.com", wildcard: true });
  });
  it("throws on an invalid entry", () => {
    expect(() => parseHostEntry("k8s.lan:0")).toThrow();
  });
  it("entryAllows judges host and port", () => {
    expect(entryAllows(parseHostEntry("k8s.lan:6443"), "k8s.lan", 6443)).toBe(true);
    expect(entryAllows(parseHostEntry("k8s.lan:6443"), "k8s.lan", 443)).toBe(false);
    expect(entryAllows(parseHostEntry("192.168.1.40"), "192.168.1.40", 6443)).toBe(false);
    expect(entryAllows(parseHostEntry("*.example.com"), "a.example.com", 443)).toBe(true);
    expect(entryAllows(parseHostEntry("*.example.com"), "example.com", 443)).toBe(false);
  });
  it("IPv6: bare without a port, bracketed with one, malformed forms refused (I3)", () => {
    expect(parseHostEntry("fd00::5")).toEqual({
      host: "fd00::5",
      ip: true,
      wildcard: false,
      ports: [80, 443],
    });
    expect(parseHostEntry("[fd00::5]:6443").ports).toEqual([6443]);
    expect(tryParseHostEntry("[::::]")).toBeNull();
    expect(tryParseHostEntry("[::::]:80")).toBeNull();
    expect(tryParseHostEntry("[1:2:3:4:5:6:7:8:9]:80")).toBeNull();
    expect(tryParseHostEntry("[fd00::5]")).toBeNull();
    expect(tryParseHostEntry("fd00::5:6443")).not.toMatchObject({ ports: [6443] });
    expect(tryParseHostEntry("::::")).toBeNull();
    expect(tryParseHostEntry("a:b:c")).toBeNull();
  });
  it("entryFor gives a bare IPv6 on 80/443 and [ip]:port otherwise, and both parse", () => {
    expect(entryFor("fd00::5", 443)).toBe("fd00::5");
    expect(entryFor("[fd00::5]", 80)).toBe("fd00::5");
    expect(entryFor("fd00::5", 6443)).toBe("[fd00::5]:6443");
    expect(tryParseHostEntry(entryFor("fd00::5", 443))).not.toBeNull();
    expect(tryParseHostEntry(entryFor("fd00::5", 6443))).not.toBeNull();
  });
});
