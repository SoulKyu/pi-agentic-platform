import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createShellPublisher } from "./shell-publisher.ts";
import { captureLogger } from "./testing/helpers.ts";

type Found = { ownerId: string; session: never } | null;

function setup(summary: (id: string) => Found = (id) => ({ ownerId: "u1", session: { id } as never })) {
  const published: Array<[string, string, unknown]> = [];
  const queued: Array<() => void> = [];
  const { logger, lines } = captureLogger();
  const publisher = createShellPublisher({
    hub: { publish: (stream, key, event) => void published.push([stream, key, event]) },
    summary: vi.fn(summary),
    project: (ownerId, projectId) => ({ id: projectId, root: "/r", name: "r", position: 1, sessions: 3 }),
    archivedCount: () => 4,
    logger,
    clock: createFakeClock(),
    schedule: (flush) => void queued.push(flush),
  });
  const flush = () => queued.splice(0).forEach((fn) => fn());
  return { published, publisher, flush, lines };
}

describe("shell publisher (M4R33)", () => {
  it("publishes each changed session once per turn, then projects, then counts, on the owner's channel", () => {
    const { published, publisher, flush } = setup();
    publisher.countsChanged("u1");
    publisher.projectChanged("u1", "p1");
    publisher.changed("s1");
    publisher.changed("s1");
    publisher.changed("s2");
    publisher.projectChanged("u1", null);
    expect(published).toEqual([]);
    flush();
    expect(published).toEqual([
      ["shell", "u1", { kind: "session", session: { id: "s1" } }],
      ["shell", "u1", { kind: "session", session: { id: "s2" } }],
      [
        "shell",
        "u1",
        { kind: "project", project: { id: "p1", root: "/r", name: "r", position: 1, sessions: 3 } },
      ],
      ["shell", "u1", { kind: "counts", archived: 4 }],
    ]);
  });

  it("skips a session that is gone, publishes the others past a throwing one, and says so once (RT-16)", () => {
    const { published, publisher, flush, lines } = setup((id) => {
      if (id.startsWith("boom")) throw new Error("db");
      return id === "gone" ? null : { ownerId: id === "s3" ? "u2" : "u1", session: { id } as never };
    });
    publisher.changed("gone");
    flush();
    expect(published).toEqual([]);
    publisher.changed("boom1");
    publisher.changed("s2");
    publisher.changed("boom2");
    publisher.changed("s3");
    publisher.countsChanged("u1");
    expect(() => flush()).not.toThrow();
    expect(published).toEqual([
      ["shell", "u1", { kind: "session", session: { id: "s2" } }],
      ["shell", "u2", { kind: "session", session: { id: "s3" } }],
      ["shell", "u1", { kind: "counts", archived: 4 }],
    ]);
    expect(lines.filter((line) => line.msg === "shell_publish_failed")).toHaveLength(1);
  });
});

describe("shell publisher status listeners (Overview)", () => {
  it("tells each listener the owner and the session once per flushed change, until it stops", () => {
    const { publisher, flush } = setup((id) => ({
      ownerId: id === "s3" ? "u2" : "u1",
      session: { id } as never,
    }));
    const heard: Array<[string, string]> = [];
    const stop = publisher.onStatus((ownerId, sessionId) => void heard.push([ownerId, sessionId]));
    publisher.changed("s1");
    publisher.changed("s1");
    publisher.changed("s3");
    expect(heard).toEqual([]);
    flush();
    expect(heard).toEqual([
      ["u1", "s1"],
      ["u2", "s3"],
    ]);
    stop();
    publisher.changed("s1");
    flush();
    expect(heard).toHaveLength(2);
  });

  it("does not tell a session that is gone, and a throwing listener neither stops the next nor the publish", () => {
    const { published, publisher, flush, lines } = setup((id) =>
      id === "gone" ? null : { ownerId: "u1", session: { id } as never },
    );
    const heard: string[] = [];
    publisher.onStatus(() => {
      throw new Error("listener");
    });
    publisher.onStatus((_ownerId, sessionId) => void heard.push(sessionId));
    publisher.changed("gone");
    publisher.changed("s1");
    expect(() => flush()).not.toThrow();
    expect(heard).toEqual(["s1"]);
    expect(published).toHaveLength(1);
    expect(lines.filter((line) => line.msg === "session_status_listener_failed")).toHaveLength(1);
  });
});
