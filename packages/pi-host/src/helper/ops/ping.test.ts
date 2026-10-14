import { VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ping } from "./ping.ts";

describe("ping", () => {
  it("reports the Pi SDK version it runs with and takes no params", async () => {
    expect(ping.params.safeParse({}).success).toBe(true);
    expect(ping.params.safeParse({ extra: 1 }).success).toBe(false);
    const ctx = {
      agentDir: "/a",
      papHome: "/p",
      home: "/h",
      signal: new AbortController().signal,
      emit: () => {},
      prompt: async () => null,
    };
    expect(await ping.run({}, ctx)).toEqual({ piVersion: VERSION });
  });
});
