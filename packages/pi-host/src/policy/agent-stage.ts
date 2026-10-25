import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type PolicyRules, SYSTEM_FOLDERS, type ToolCategory } from "@pap/contracts/pi-host";
import { agentCategory, type AgentCallFacts, decideIsolated } from "./agent-decide.ts";
import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { readsInside, SESSION_FOLDER } from "./read-target.ts";
import { checkEditTarget, ownFolder, realTarget, RUNS_DIR, within } from "./target-path.ts";

export const SANDBOXED_SHELL_REASON = "sandboxed shell, its own folder only";

/**
 * Owner a6 (i), W5-R34, W5-R53: in an agent thread whose rules carry an `autonomy` with a host list of its own, pap's networked
 * sandboxed shell (the proxy keeps it to those hosts) is judged as if the thread were clean. An agent without hosts
 * (`autonomy.hosts` empty), an isolated task, an owner session and every other tool get nothing.
 */
export function autonomous(call: Pick<CallFacts, "kind" | "rules">): boolean {
  const { rules, kind } = call;
  return (
    rules.profile === "agent-thread" &&
    rules.autonomy !== null &&
    rules.autonomy.hosts.length > 0 &&
    kind.sandboxed === true &&
    kind.external &&
    rules.sandbox?.network === true
  );
}

/** The one folder the rules let the session edit as its own: an agent thread's home, a project session's project folder, an isolated task's scratch folder. */
export function agentOwnOf(rules: PolicyRules): string | null {
  if (rules.profile === "agent-thread" || rules.profile === "project") return rules.agentHome;
  return rules.profile === "isolated-task" ? rules.agentScratch : null;
}

/** In a VM the folder the rules name for the session's shell is the VM's own: its home, or a project box's project folder (the host has no agent folder to check). */
export const vmOwnFolder = (rules: PolicyRules, vm: NonNullable<PipelineDeps["vm"]>): boolean =>
  agentOwnOf(rules) === (rules.profile === "project" ? vm.layout.project : vm.layout.home);

/**
 * Without a `sandbox` in the rules a sandboxed shell is judged as if it had network: the stricter reading. In a VM
 * (`inVm`) the egress proxy keeps a networked shell to the agent's host list, so it is judged as without network.
 */
function factsOf(call: CallFacts, inVm: boolean): AgentCallFacts {
  return {
    category: call.kind.category,
    external: call.kind.external,
    sandboxedShell: call.kind.sandboxed === true,
    sandboxNetwork: !inVm && call.rules.sandbox?.network !== false,
  };
}

/** What stage 03 judges: the call's category, but a sandboxed shell without network is an edit of its own folder (M11R30). */
export function judgedAs(call: CallFacts, inVm = false): { category: ToolCategory; external: boolean } {
  if (call.rules.profile === "interactive")
    return { category: call.kind.category, external: call.kind.external };
  return agentCategory(factsOf(call, inVm));
}

const pathOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

/** The paths a built-in read names, as `readsInside` takes them: `read` has no default path, the others default to the cwd. */
const readPaths = (call: CallFacts): unknown[] =>
  call.event.toolName === "read" || pathOf(call.event.input) !== undefined ? [pathOf(call.event.input)] : [];

/**
 * `agents/.runs/...` relative to pap's home: judged on the REAL path of each folder below the REAL home, so a spelling of
 * the home that is neither its path nor its real path (another link to it) is judged like the others.
 */
const isScratch = async (folders: readonly string[], realHome: string): Promise<boolean> => {
  for (const each of folders) {
    const real = await realTarget(each);
    if (!within(realHome, real) || relative(realHome, real).split(sep)[1] !== RUNS_DIR) return false;
  }
  return true;
};

/** The folder the rules name, in every spelling, when it is an agent folder in fact of the wanted kind: a home, or a scratch folder. */
async function named(
  path: string | null,
  scratch: boolean,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<string[] | null> {
  if (path === null) return null;
  const folders = await ownFolder(ctx.cwd, deps.papHome, path);
  const realHome = await realTarget(resolve(deps.papHome));
  return folders.length > 0 && (await isScratch(folders, realHome)) === scratch ? [...folders] : null;
}

/** Whether the folder the rules name for the session's shell is an agent folder in fact (M3): a shell with none is refused. */
export async function hasOwnFolder(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<boolean> {
  if (deps.vm) return vmOwnFolder(call.rules, deps.vm);
  return (await named(agentOwnOf(call.rules), call.rules.profile === "isolated-task", ctx, deps)) !== null;
}

/** The roots of an isolated task's reads: the folders its rules name, shape-checked (M2); null when one is no agent folder. */
async function reachRoots(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps): Promise<string[] | null> {
  const home = call.rules.agentHome === null ? [] : await named(call.rules.agentHome, false, ctx, deps);
  const scratch = await named(call.rules.agentScratch, true, ctx, deps);
  return home === null || scratch === null ? null : [...home, ...scratch];
}

/** Whether everything the call names lies where an isolated task may reach: false when unsure. */
async function insideReach(call: CallFacts, category: ToolCategory, ctx: PolicyContext, deps: PipelineDeps) {
  // In a VM the file rule judged a built-in's paths already, and bwrap confines pap's shell to the VM's home.
  if (deps.vm)
    return call.kind.sandboxed === true
      ? vmOwnFolder(call.rules, deps.vm)
      : call.kind.builtin && (category === "read" || category === "edit");
  const scratch = call.rules.agentScratch;
  const folders = await named(scratch, true, ctx, deps);
  if (scratch === null || folders === null) return false;
  // pap's sandboxed shell names no path: bwrap confines it to the scratch folder, which is named and real.
  if (call.kind.sandboxed === true) return true;
  if (!call.kind.builtin) return false;
  if (category === "read") {
    const roots = await reachRoots(call, ctx, deps);
    return roots !== null && readsInside(readPaths(call), ctx.cwd, roots);
  }
  if (category !== "edit") return false;
  // The write must start from the scratch folder itself and land in it (the home is read-only, owner m17).
  if (!(await readsInside([ctx.cwd], ctx.cwd, folders))) return false;
  const check = await checkEditTarget(
    pathOf(call.event.input),
    ctx.cwd,
    [deps.agentDir, deps.papHome],
    deps.papHome,
    scratch,
  );
  return check.auto;
}

export const OUTSIDE_FOLDER_REASON = "outside this agent's folder";

/**
 * W5-R63: an agent thread's built-in file tools read its home, the files attached to the thread and the system folders of
 * its sandbox view, plus its own runs folder (W5-R65) and Pi's skills folder (W5-R66, read-only, not fenced), and nothing else, in every mode. True: the call reaches further (or the rules name no agent home), so
 * stage 03 blocks it, with no question. The isolated task's read rule (`readsInside`) does the judging.
 */
export async function readsOutsideThread(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps) {
  if (deps.vm) return false; // the VM file stage judged it
  const home = call.rules.agentHome === null ? null : await named(call.rules.agentHome, false, ctx, deps);
  if (home === null) return true;
  const sessionId = deps.sessionId?.();
  const attachments =
    sessionId !== undefined && SESSION_FOLDER.test(sessionId)
      ? [
          join(deps.papHome, "attachments", sessionId),
          join(await realTarget(deps.papHome), "attachments", sessionId),
        ]
      : [];
  // Its own runs folder holds its isolated tasks' output, read as external content (W5-R65, owner m17).
  const runs = home.map((each) => join(dirname(each), RUNS_DIR, basename(each)));
  return !(await readsInside(
    readPaths(call),
    ctx.cwd,
    [...home, ...runs, ...attachments, join(deps.agentDir, "skills"), ...SYSTEM_FOLDERS],
    true,
  ));
}

/** Stage 03 of an isolated task (M11R32): `decideIsolated` over the facts, nothing a grant can skip. */
export async function isolatedPlan(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ApprovalPlan> {
  const { rules } = call;
  const mode = rules.approvalMode;
  const { category } = judgedAs(call, deps.vm !== undefined);
  const refused = (reason: string): ApprovalPlan => ({
    outcome: "block",
    reason,
    modelReason: `pap-policy blocked this ${category} call.`,
  });
  if (mode === "full-access") return refused("full access is never an isolated task's mode");
  const verdict = decideIsolated({
    ...factsOf(call, deps.vm !== undefined),
    mode,
    tainted: call.tainted,
    insideReach: await insideReach(call, category, ctx, deps),
    hostList: rules.allowHosts !== null,
  });
  if (verdict.decision === "block") return refused(verdict.why);
  if (verdict.decision === "allow") return { outcome: "allow", reason: verdict.why };
  return { outcome: "ask", reason: verdict.why, answers: verdict.answers, grantable: false };
}
