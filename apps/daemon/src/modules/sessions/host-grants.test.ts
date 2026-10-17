import { MAX_HOST_GRANTS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createHostGrants } from "./host-grants.ts";

describe("the host grants of agent threads (owner a2, M11R210)", () => {
  it("notes, answers has and of, and drops", () => {
    const grants = createHostGrants();
    expect(grants.has("s1", "api.example.com")).toBe(false);
    expect(grants.of("s1")).toEqual([]);
    grants.note("s1", "api.example.com");
    grants.note("s1", "docs.example.com");
    grants.note("s1", "api.example.com");
    expect(grants.has("s1", "api.example.com")).toBe(true);
    expect(grants.of("s1")).toEqual(["api.example.com", "docs.example.com"]);
    grants.drop("s1");
    expect(grants.has("s1", "api.example.com")).toBe(false);
    expect(grants.of("s1")).toEqual([]);
  });

  it("ignores a malformed host", () => {
    const grants = createHostGrants();
    for (const host of [
      "*.example.com",
      "localhost",
      "93.184.216.34",
      "Example.com",
      "a.example.com:443",
      "",
    ])
      grants.note("s1", host);
    expect(grants.of("s1")).toEqual([]);
  });

  it("keeps 64 hosts and refuses the 65th with a host_grant_limit line that names no host", () => {
    const { logger, lines } = captureLogger();
    const grants = createHostGrants(logger);
    for (let index = 0; index <= MAX_HOST_GRANTS; index++) grants.note("s1", `h${index}.example.com`);
    expect(grants.of("s1")).toHaveLength(64);
    expect(grants.has("s1", "h64.example.com")).toBe(false);
    expect(grants.has("s1", "h63.example.com")).toBe(true);
    const limits = lines.filter((line) => line["msg"] === "host_grant_limit");
    expect(limits).toEqual([expect.objectContaining({ level: "warn", sessionId: "s1" })]);
    expect(JSON.stringify(lines)).not.toContain("example.com");
    grants.note("s1", "h0.example.com");
    expect(lines.filter((line) => line["msg"] === "host_grant_limit")).toHaveLength(1);
  });

  it("never shares a grant between two sessions", () => {
    const grants = createHostGrants();
    grants.note("s1", "api.example.com");
    expect(grants.has("s2", "api.example.com")).toBe(false);
    grants.drop("s2");
    expect(grants.has("s1", "api.example.com")).toBe(true);
  });

  it("hands out a copy, not the record", () => {
    const grants = createHostGrants();
    grants.note("s1", "api.example.com");
    (grants.of("s1") as string[]).push("evil.example.com");
    expect(grants.of("s1")).toEqual(["api.example.com"]);
  });
});
