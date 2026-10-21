import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createAgentFiles } from "./agent-files.ts";
import { agentFilesRpc } from "./agent-files-rpc.ts";
import { createAgentFilesService } from "./agent-files-service.ts";

const AGENT = "atlas-0000";
let root: string;
const audit = { append: vi.fn() };
const owns = vi.fn((ownerId: string, agentId: string) => ownerId === "u1" && agentId === AGENT);

function make() {
  const files = createAgentFiles({ secretsDir: join(root, "secrets"), logger: captureLogger().logger });
  const service = createAgentFilesService({ files, owns, audit });
  return { files, service, rpc: agentFilesRpc(service) };
}
const ctx = (caller: Caller = testCaller()) => ({ caller }) as never;
const refusal = async (work: () => unknown): Promise<string | undefined> => {
  try {
    await work();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-agent-files-service-"));
  audit.append.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("agents.files handlers", () => {
  it("list what the store holds for the owner's agent, and remove one file", async () => {
    const { rpc, service } = make();
    service.put(testCaller(), AGENT, ".kube/config", Buffer.from("x"));
    const listed = await rpc["agents.files.list"]({ agentId: AGENT }, ctx());
    expect(listed.files).toEqual([{ path: ".kube/config", size: 1, importedAt: expect.any(Number) }]);
    expect(await rpc["agents.files.remove"]({ agentId: AGENT, path: ".kube/config" }, ctx())).toEqual({
      ok: true,
    });
    expect((await rpc["agents.files.list"]({ agentId: AGENT }, ctx())).files).toEqual([]);
  });

  it("answer not_found for another owner's agent, for list, remove and put alike, and touch nothing", async () => {
    const { rpc, service, files } = make();
    const stranger = testCaller({ userId: "u2" });
    expect(await refusal(() => rpc["agents.files.list"]({ agentId: AGENT }, ctx(stranger)))).toBe(
      "not_found",
    );
    expect(
      await refusal(() => rpc["agents.files.remove"]({ agentId: AGENT, path: "a" }, ctx(stranger))),
    ).toBe("not_found");
    expect(await refusal(() => service.put(stranger, AGENT, "a", Buffer.from("x")))).toBe("not_found");
    expect(files.list(AGENT)).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("answer not_found for a file that is not there", async () => {
    const { rpc } = make();
    expect(await refusal(() => rpc["agents.files.remove"]({ agentId: AGENT, path: "ghost" }, ctx()))).toBe(
      "not_found",
    );
  });

  it("audit an import and a removal with the path and never the content", () => {
    const { service } = make();
    service.put(testCaller(), AGENT, "a/token.json", Buffer.from("TOPSECRET-CONTENT"));
    service.remove(testCaller(), AGENT, "a/token.json");
    expect(audit.append.mock.calls.map(([row]) => [row.reason, row.detail])).toEqual([
      ["agent file imported", { agentId: AGENT, path: "a/token.json", bytes: 17 }],
      ["agent file removed", { agentId: AGENT, path: "a/token.json" }],
    ]);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("TOPSECRET-CONTENT");
  });
});
