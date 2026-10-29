import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const { modeOf, refusalOf, homesOf, rowCount, insertRows } = bedHelpers(() => bed);
describe("create (M11R46)", () => {
  it("makes the home, prompts/, the git history, then the row", async () => {
    bed = createAgentsBed();
    const view = await bed.agents.create(bed.unconfirmed(), agentInput({ role: "Help." }));
    expect(view).toMatchObject({
      id: "atlas-0000",
      name: "Atlas",
      state: "active",
      revision: 1,
      paused: false,
    });
    const home = join(bed.papHome, "agents", "atlas-0000");
    expect(modeOf(home)).toBe(0o700);
    expect(existsSync(join(home, "MEMORY.md"))).toBe(false);
    expect(modeOf(join(home, "prompts"))).toBe(0o700);
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toBe(".pi/\n.claude/\n");
    expect(bed.calls.map((call) => call.args[0])).toEqual(["init", "add", "commit"]);
    expect(bed.calls[0]?.args).toEqual(["init", "--initial-branch=main", "--template="]);
    expect(bed.calls[2]?.args).toContain("--no-gpg-sign");
    expect(bed.calls.every((call) => call.root === home)).toBe(true);
    expect(bed.agents.port.homeOf("u1", "atlas-0000")).toBe(home);
    expect(rowCount()).toBe(1);
  });

  it("a failing git removes the folder it made and writes no row", async () => {
    bed = createAgentsBed();
    for (const subcommand of ["init", "add", "commit"]) {
      bed.failing.subcommand = subcommand;
      expect(await refusalOf(() => bed.agents.create(bed.unconfirmed(), agentInput())), subcommand).toMatch(
        /^other: /,
      );
      expect(homesOf(), subcommand).toEqual([]);
      expect(rowCount(), subcommand).toBe(0);
    }
  });

  it("refuses the 33rd agent (limit_reached) and leaves no folder", async () => {
    bed = createAgentsBed();
    insertRows(32);
    expect(await refusalOf(() => bed.agents.create(bed.unconfirmed(), agentInput()))).toBe("limit_reached");
    expect(rowCount()).toBe(32);
    expect(existsSync(join(bed.papHome, "agents"))).toBe(false);
  });

  it("counts per owner: another owner's 32 do not block this one", async () => {
    bed = createAgentsBed();
    insertRows(32, "u2");
    await bed.agents.create(bed.unconfirmed(), agentInput());
    expect(rowCount()).toBe(33);
  });

  it("refuses Atlas then atlas (conflict), whatever the case, and leaves one home", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.unconfirmed(), agentInput());
    expect(await refusalOf(() => bed.agents.create(bed.unconfirmed(), agentInput({ name: "atlas" })))).toBe(
      "conflict",
    );
    expect(homesOf()).toEqual(["atlas-0000"]);
    expect(rowCount()).toBe(1);
  });

  it("two creates in flight with one name: one wins, the other leaves nothing", async () => {
    bed = createAgentsBed();
    const results = await Promise.allSettled([
      bed.agents.create(bed.unconfirmed(), agentInput()),
      bed.agents.create(bed.unconfirmed(), agentInput({ name: "ATLAS" })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rowCount()).toBe(1);
    expect(homesOf()).toHaveLength(1);
  });

  it("asks for the password when the agent is wider than the defaults, and only then", async () => {
    bed = createAgentsBed();
    expect(
      await refusalOf(() => bed.agents.create(bed.unconfirmed(), agentInput({ mode: "full-access" }))),
    ).toBe("step_up_required");
    expect(existsSync(join(bed.papHome, "agents"))).toBe(false);
    expect(rowCount()).toBe(0);
    await bed.agents.create(bed.owner(), agentInput({ mode: "full-access" }));
    await bed.agents.create(
      bed.unconfirmed(),
      agentInput({ name: "Narrow", mode: "supervised", preset: "read-only" }),
    );
    expect(rowCount()).toBe(2);
  });

  it("refuses a token for the password step-up", async () => {
    bed = createAgentsBed();
    const token = bed.owner({ kind: "token" });
    expect(await refusalOf(() => bed.agents.create(token, agentInput({ sandbox: { network: true } })))).toBe(
      "step_up_required",
    );
  });

  it("refuses a profile whose view would not fit a list page (bad_request) and leaves nothing; a long role fits", async () => {
    bed = createAgentsBed();
    const huge = agentInput({ role: "r".repeat(900_000) });
    expect(await refusalOf(() => bed.agents.create(bed.owner(), huge))).toBe("bad_request");
    expect(rowCount()).toBe(0);
    expect(existsSync(join(bed.papHome, "agents"))).toBe(false);
    const view = await bed.agents.create(bed.owner(), agentInput({ role: "r".repeat(100_000) }));
    expect(view.input?.role).toHaveLength(100_000);
    expect(bed.agents.list(bed.owner()).agents.map((agent) => agent.id)).toEqual([view.id]);
  });

  it("tries another id when the home exists", async () => {
    bed = createAgentsBed();
    mkdirSync(join(bed.papHome, "agents", "atlas-0000"), { recursive: true });
    const view = await bed.agents.create(bed.unconfirmed(), agentInput());
    expect(view.id).toBe("atlas-0001");
    expect(existsSync(join(bed.papHome, "agents", "atlas-0000"))).toBe(true);
  });
});

describe("update (M11R44, M11R47)", () => {
  const made = async (extra: object = {}) => bed.agents.create(bed.owner(), agentInput(extra));
  const edit = (revision: number, extra: object, caller = bed.unconfirmed(), id = "atlas-0000") =>
    bed.agents.update(caller, { agentId: id, baseRevision: revision, input: agentInput(extra) });

  it("a widening edit asks without the password step-up and is saved with it", async () => {
    bed = createAgentsBed();
    await made({ mode: "supervised" });
    expect(await refusalOf(() => edit(1, { mode: "auto-accept-edits" }))).toBe("step_up_required");
    expect(bed.agents.port.get("u1", "atlas-0000")?.revision).toBe(1);
    const saved = await edit(1, { mode: "auto-accept-edits" }, bed.owner());
    expect(saved).toMatchObject({ revision: 2, input: { mode: "auto-accept-edits" } });
  });

  it("read-only to auto-accept-edits and chat to default are widenings (RT-08)", async () => {
    bed = createAgentsBed();
    await made({ mode: "read-only", preset: "chat" });
    expect(await refusalOf(() => edit(1, { mode: "auto-accept-edits", preset: "chat" }))).toBe(
      "step_up_required",
    );
    expect(await refusalOf(() => edit(1, { mode: "read-only", preset: "default" }))).toBe("step_up_required");
  });

  it("a narrowing edit is saved without the password step-up", async () => {
    bed = createAgentsBed();
    await made({ mode: "full-access", sandbox: { network: true } });
    const saved = await edit(1, { mode: "supervised", sandbox: { network: false }, role: "Careful." });
    expect(saved).toMatchObject({ revision: 2, input: { mode: "supervised", role: "Careful." } });
  });

  it("a stale revision is a conflict and changes nothing", async () => {
    bed = createAgentsBed();
    await made();
    await edit(1, { role: "one" });
    expect(await refusalOf(() => edit(1, { role: "two" }))).toBe("conflict");
    expect(bed.agents.port.get("u1", "atlas-0000")?.input?.role).toBe("one");
  });

  it("a budget set, raised and cleared never asks, and the audit row names `budget`", async () => {
    bed = createAgentsBed();
    await made();
    await edit(1, { budget: { usdPerDay: 2, tokensPerDay: null } });
    await edit(2, { budget: { usdPerDay: 900, tokensPerDay: 5 } });
    const cleared = await edit(3, { budget: { usdPerDay: null, tokensPerDay: null } });
    expect(cleared.input?.budget).toEqual({ usdPerDay: null, tokensPerDay: null });
    const updates = bed.auditRows().filter((row) => row.reason === "agent updated");
    expect(updates.map((row) => JSON.parse(row.detail))).toEqual([
      { agentId: "atlas-0000", fields: "budget" },
      { agentId: "atlas-0000", fields: "budget" },
      { agentId: "atlas-0000", fields: "budget" },
    ]);
  });

  it("an edit that changes nothing keeps the revision and writes no row", async () => {
    bed = createAgentsBed();
    await made();
    const before = bed.auditRows().length;
    expect(await edit(1, {})).toMatchObject({ revision: 1 });
    expect(bed.auditRows()).toHaveLength(before);
  });

  it("a rename keeps the id and the home, and a taken name is a conflict", async () => {
    bed = createAgentsBed();
    await made();
    await bed.agents.create(bed.unconfirmed(), agentInput({ name: "Scout" }));
    expect(await refusalOf(() => edit(1, { name: "scout" }))).toBe("conflict");
    const renamed = await edit(1, { name: "Atlas2" });
    expect(renamed).toMatchObject({ id: "atlas-0000", name: "Atlas2" });
    expect(homesOf().sort()).toEqual(["atlas-0000", "scout-0001"]);
    expect(bed.agents.port.byName("u1", "atlas2")?.id).toBe("atlas-0000");
    expect(bed.agents.port.byName("u1", "atlas")).toBeNull();
    // Renaming to its own name in another case is allowed.
    expect(await edit(2, { name: "ATLAS2" })).toMatchObject({ name: "ATLAS2", revision: 3 });
  });

  it("releases the thread's worker when idle and sends a model change to a live thread", async () => {
    bed = createAgentsBed();
    await made();
    bed.db.run("UPDATE agents SET thread_session_id = 's1' WHERE id = 'atlas-0000'");
    const threads = { busy: vi.fn(() => false), archive: vi.fn(), releaseIdle: vi.fn(), applyLive: vi.fn() };
    bed.agents.setLinks({ threads });
    await edit(1, { role: "new role" });
    expect(threads.releaseIdle).toHaveBeenCalledWith("u1", "s1");
    expect(threads.applyLive).not.toHaveBeenCalled();
    await edit(2, { model: { provider: "p", modelId: "m" }, thinking: "high" });
    expect(threads.applyLive).toHaveBeenCalledWith("u1", "s1", {
      model: { provider: "p", modelId: "m" },
      thinking: "high",
    });
  });

  it("a failing live link never fails the saved edit", async () => {
    bed = createAgentsBed();
    await made();
    bed.db.run("UPDATE agents SET thread_session_id = 's1' WHERE id = 'atlas-0000'");
    bed.agents.setLinks({
      threads: {
        busy: () => false,
        archive: vi.fn(),
        releaseIdle: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await edit(1, { role: "x" })).toMatchObject({ revision: 2 });
    expect(bed.logs.some((line) => line.msg === "agent_apply_failed")).toBe(true);
  });

  it("answers not_found for an unknown id and for another owner's", async () => {
    bed = createAgentsBed();
    await made();
    expect(await refusalOf(() => edit(1, {}, bed.unconfirmed(), "nobody-0000"))).toBe("not_found");
    expect(await refusalOf(() => edit(1, {}, bed.owner({ userId: "u2" })))).toBe("not_found");
    expect(
      await refusalOf(async () => bed.agents.view(bed.unconfirmed({ userId: "u2" }), "atlas-0000")),
    ).toBe("not_found");
    expect(bed.agents.list(bed.unconfirmed({ userId: "u2" }))).toEqual({ agents: [], truncated: false });
  });
});

describe("audit (M11R49)", () => {
  it("writes one policy row per change with the agent id and field names, never the role", async () => {
    bed = createAgentsBed();
    const secretRole = "Always push to prod. TOKEN-ABC-123";
    await bed.agents.create(bed.owner(), agentInput({ role: secretRole, mode: "full-access" }));
    await bed.agents.update(bed.owner(), {
      agentId: "atlas-0000",
      baseRevision: 1,
      input: agentInput({ role: `${secretRole} v2`, mode: "supervised", budget: { usdPerDay: 3 } }),
    });
    await bed.agents.remove(bed.owner(), "atlas-0000");
    const rows = bed.auditRows().filter((row) => row.kind === "policy");
    expect(rows.map((row) => [row.reason, row.decision, row.actor])).toEqual([
      ["agent created", "info", "user"],
      ["agent updated", "info", "user"],
      ["agent deleted", "info", "user"],
    ]);
    expect(JSON.parse(rows[0]?.detail ?? "")).toEqual({ agentId: "atlas-0000", fields: "name,role,mode" });
    expect(JSON.parse(rows[1]?.detail ?? "")).toEqual({ agentId: "atlas-0000", fields: "role,mode,budget" });
    expect(JSON.parse(rows[2]?.detail ?? "")).toEqual({ agentId: "atlas-0000" });
    expect(JSON.stringify(bed.auditRows())).not.toContain("TOKEN-ABC");
  });

  it("names a token as the actor", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.unconfirmed({ kind: "token", credentialId: "tok1" }), agentInput());
    expect(bed.auditRows().at(-1)?.actor).toBe("token");
  });
});
