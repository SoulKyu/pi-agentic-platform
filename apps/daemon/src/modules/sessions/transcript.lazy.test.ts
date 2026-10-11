import { describe, expect, it, vi } from "vitest";

// The SDK is heavy (about 120 MB resident and half a second to load). Nothing may load it until a transcript is read.
const sdk = vi.hoisted(() => ({ loads: 0 }));
vi.mock("@earendil-works/pi-coding-agent", () => {
  sdk.loads++;
  return {
    parseSessionEntries: () => [],
    migrateSessionEntries: () => {},
    buildSessionContext: () => ({ messages: [] }),
  };
});

// Everything the module is made of, loaded the way the daemon loads it.
import "./index.ts";
import { loadTranscriptReader } from "./transcript.ts";

describe("the Pi SDK", () => {
  it("is not loaded with the sessions module, only when a transcript reader is asked for (R108)", async () => {
    expect(sdk.loads).toBe(0);
    const first = await loadTranscriptReader();
    expect(sdk.loads).toBe(1);
    expect(await loadTranscriptReader()).toBe(first);
    expect(sdk.loads).toBe(1);
    expect(first.tail("/does/not/exist.jsonl")).toEqual([]);
  });
});
