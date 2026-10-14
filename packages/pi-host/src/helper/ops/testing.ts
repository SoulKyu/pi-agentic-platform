import { spawn } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { HELPER_MAX_RECORD_BYTES } from "@pap/contracts";
import { z } from "zod";
import { defineOp, type OpTable } from "../ops.ts";

const NONE = z.object({}).strict();

/**
 * Operations the pool tests use to provoke a helper's failure modes. They exist only when the daemon was started for
 * tests (`PAP_TEST_PROVIDER=1`, see `opsFor`); a production helper answers `unknown_op` to every one of them.
 */
export const testOps: OpTable = {
  // Never ends and ignores the cancel; starts a child in its process group, so the kill must reach the group.
  "test.hang": defineOp({
    params: NONE,
    run: async (_params, ctx) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      ctx.emit({ childPid: child.pid });
      setInterval(() => {}, 1000);
      return new Promise<never>(() => {});
    },
  }),
  // `megabytes` MiB on stdout (honouring backpressure): the daemon keeps a tail and the helper still completes.
  "test.print": defineOp({
    params: z
      .object({ megabytes: z.number().int().min(1).max(100), exitAfter: z.boolean().optional() })
      .strict(),
    run: async (params) => {
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let i = 0; i < params.megabytes; i++)
        if (!process.stdout.write(chunk))
          await new Promise((resolve) => process.stdout.once("drain", resolve));
      // Flushed before any exit: a pipe that is full queues the write, and `process.exit` drops what is queued.
      await new Promise<void>((resolve) => process.stdout.write("END-OF-OUTPUT", () => resolve()));
      if (params.exitAfter) process.exit(3);
      return { printed: params.megabytes };
    },
  }),
  "test.prompt": defineOp({
    params: z.object({ prompt: z.string() }).strict(),
    run: async (params, ctx) => ({ answer: await ctx.prompt({ text: params.prompt }) }),
  }),
  "test.prompts": defineOp({
    params: z.object({ count: z.number().int().min(1).max(64) }).strict(),
    run: async (params, ctx) => {
      for (let i = 0; i < params.count; i++) void ctx.prompt({ n: i });
      return new Promise<never>(() => {});
    },
  }),
  "test.events": defineOp({
    params: z.object({ count: z.number().int().min(1).max(1000) }).strict(),
    run: async (params, ctx) => {
      for (let i = 0; i < params.count; i++) ctx.emit({ n: i });
      return { emitted: params.count };
    },
  }),
  // Straight to the channel, around the helper's own bound: what a misbehaving helper would do.
  "test.rogue": defineOp({
    params: z.object({ kind: z.enum(["oversized", "garbage", "unknown_type"]) }).strict(),
    run: async (params) => {
      const record =
        params.kind === "oversized"
          ? { type: "helper_event", event: "x".repeat(HELPER_MAX_RECORD_BYTES + 1) }
          : params.kind === "garbage"
            ? { nonsense: true }
            : { type: "response", id: "r1" };
      process.send?.(record);
      return new Promise<never>(() => {});
    },
  }),
  "test.env": defineOp({
    params: NONE,
    run: async () => ({ env: { ...process.env }, cwd: process.cwd(), execArgv: process.execArgv }),
  }),
  // Where each open descriptor of the helper points (MC29: no inherited pty master may be among them).
  "test.fds": defineOp({
    params: NONE,
    run: async () => ({
      links: readdirSync("/proc/self/fd").flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/self/fd/${fd}`)];
        } catch {
          return [];
        }
      }),
    }),
  }),
  "test.throw": defineOp({
    params: NONE,
    run: async () => {
      throw new Error("deliberate failure");
    },
  }),
  "test.exit": defineOp({
    params: z.object({ code: z.number().int() }).strict(),
    run: async (params) => process.exit(params.code),
  }),
};
