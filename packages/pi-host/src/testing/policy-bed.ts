import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, PolicyRules } from "@pap/contracts";
import { evaluateToolCall } from "../policy/extension.ts";

export const interactiveRules: PolicyRules = { profile: "interactive", approvalMode: "auto-accept-edits" };

export interface HarnessOptions {
  confirm?: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  rules?: () => PolicyRules | null;
  hasUI?: boolean;
  audit?: (entry: AuditEntry) => void;
  cwd?: string;
  signal?: AbortSignal;
  isBuiltinTool?: (name: string) => boolean;
}

/** Temporary directories for a policy test: `cwd` is the session directory, `outside`, `agentDir` and `papHome` are not. */
export async function createPolicyBed() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pap-policy-")));
  const cwd = join(base, "proj");
  const outside = join(base, "outside");
  const agentDir = join(base, "agent");
  const papHome = join(base, "pap");
  for (const dir of [join(cwd, "src"), outside, agentDir, papHome]) await mkdir(dir, { recursive: true });

  function harness(options: HarnessOptions = {}) {
    const audits: AuditEntry[] = [];
    const asked: string[] = [];
    const run = (toolName: string, input: unknown, toolCallId = "c1") =>
      evaluateToolCall(
        { toolCallId, toolName, input },
        {
          hasUI: options.hasUI ?? true,
          cwd: options.cwd ?? cwd,
          signal: options.signal,
          ui: {
            confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) => {
              asked.push(`${title}|${message}`);
              return (options.confirm ?? (async () => true))(title, message, opts);
            },
          },
        },
        {
          rules: options.rules ?? (() => interactiveRules),
          audit: options.audit ?? ((entry) => audits.push(entry)),
          agentDir,
          papHome,
          isBuiltinTool: options.isBuiltinTool ?? (() => true),
        },
      );
    return { audits, asked, run };
  }

  return {
    base,
    cwd,
    outside,
    agentDir,
    papHome,
    harness,
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
