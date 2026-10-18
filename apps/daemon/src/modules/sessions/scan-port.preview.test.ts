import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const bed = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let current: ReturnType<typeof bed>;
afterEach(() => current.dispose());

const T = 1_800_000_000_000;

describe("the preview of a session that starts with outside text", () => {
  it("keeps the fence markup of a webhook task out of the tab label", () => {
    current = bed();
    const row = { id: "s1", piPath: null, piSessionId: null, cwd: current.work, ownerId: "u1", name: null };
    current.store.insert({ ...row, createdAt: T, updatedAt: T }, null);
    current.service.scanPort.previewed(
      "s1",
      '<untrusted source="alertmanager" id="0a1b2c3d4e5f">\nDisk full on node 3\n</untrusted id="0a1b2c3d4e5f">',
    );
    expect(current.store.marks.row("s1")?.preview).toBe("Disk full on node 3");
  });

  it("stores nothing for an empty fenced payload, so a later real preview still lands", () => {
    current = bed();
    const row = { id: "s1", piPath: null, piSessionId: null, cwd: current.work, ownerId: "u1", name: null };
    current.store.insert({ ...row, createdAt: T, updatedAt: T }, null);
    current.service.scanPort.previewed(
      "s1",
      '<untrusted source="hook" id="0a1b2c3d4e5f">\n\n</untrusted id="0a1b2c3d4e5f">',
    );
    expect(current.store.marks.row("s1")?.preview).toBeNull();
    current.service.scanPort.previewed("s1", "real words");
    expect(current.store.marks.row("s1")?.preview).toBe("real words");
  });
});
