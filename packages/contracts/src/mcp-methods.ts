import { z } from "zod";
import { ClientPath } from "./client-path.ts";
import { defineMethod } from "./define.ts";

/** What the MCP overview holds at most (M7R84): a file with more servers lists none of them. */
export const MCP_LIMITS = { servers: 200, names: 32, nameLength: 64, target: 2048 } as const;

const Cwd = ClientPath;
const Name = z.string().min(1).max(MCP_LIMITS.nameLength);

/** Why a whole file is not listed (M7R84). A file that is simply missing has no problem and no servers. */
export const McpFileProblem = z.enum([
  "unparsable",
  "invalid-shape",
  "too-many-servers",
  "too-large",
  "not-a-file",
  "link-outside",
  "link-dangling",
]);
export type McpFileProblem = z.infer<typeof McpFileProblem>;

export const McpTestState = z.enum(["connected", "needs-sign-in", "failed", "timeout"]);
export type McpTestState = z.infer<typeof McpTestState>;
/** The last Test of a server, kept by the daemon (M7R97); the helper reads files only, so it answers `null` (M7R82). */
export const McpTestView = z
  .object({
    at: z.number(),
    ok: z.boolean(),
    /** What the Test said, so a reloaded panel can tell "needs sign-in" from "failed" (MC45 M3). */
    state: McpTestState,
    tools: z.number().int().min(0).max(100_000).nullable(),
  })
  .strict();
export type McpTestView = z.infer<typeof McpTestView>;

const NameList = z.array(Name).max(MCP_LIMITS.names);

/**
 * One server as the browser may see it (M7R83): names only for `env` and `headers`, the command, arguments and URL
 * masked word by word, nothing from a literal value. `problem` is a fixed phrase of this module, never Pi's text.
 */
export const McpServerView = z
  .object({
    name: Name,
    scope: z.enum(["global", "project"]),
    kind: z.enum(["stdio", "http", "override", "invalid"]),
    enabled: z.boolean(),
    exposure: z.enum(["codemode", "deferred", "direct", "hidden"]),
    target: z.string().max(MCP_LIMITS.target),
    cwd: z.string().max(1024).optional(),
    envNames: NameList,
    headerNames: NameList,
    /** The fields whose whole value is a `!command` (`env.TOKEN`, `headers.Authorization`): reported, never run (M7R82). */
    commandFields: z.array(z.string().max(MCP_LIMITS.nameLength + 16)).max(MCP_LIMITS.names),
    /** The `${NAME}` / `$NAME` variables the entry refers to: names only, never resolved. */
    variables: NameList,
    oauth: z.boolean(),
    toolExposureCount: z.number().int().min(0).max(100_000),
    state: z.enum(["on", "disabled", "not-trusted", "replaced", "overridden", "invalid"]),
    lastTest: McpTestView.nullable(),
    problem: z.string().max(64).nullable(),
  })
  .strict();
export type McpServerView = z.infer<typeof McpServerView>;

export const McpFileView = z
  .object({
    path: z.string().max(4096),
    problem: McpFileProblem.nullable(),
    /** The project's trust decision; `null` for the global file. */
    trusted: z.boolean().nullable(),
    servers: z.array(McpServerView).max(MCP_LIMITS.servers),
  })
  .strict();
export type McpFileView = z.infer<typeof McpFileView>;

export const CodemodeView = z
  .object({ autoEnable: z.boolean(), source: z.enum(["default", "global", "project"]) })
  .strict();
export type CodemodeView = z.infer<typeof CodemodeView>;

/** Code mode as `settings.json` says it: Automatic / Always on, the built-in tools beside it, the inline budget. */
export const CodemodeSettings = z
  .object({
    choice: z.enum(["automatic", "always"]),
    mode: z.enum(["on", "only"]),
    inlineBudget: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .strict();
export type CodemodeSettings = z.infer<typeof CodemodeSettings>;

export const McpOverview = z
  .object({
    global: McpFileView,
    project: McpFileView.nullable(),
    codemode: CodemodeView,
    /** The code mode keys of the global `settings.json` (M7R92); `null` when that file cannot be read (MC44). */
    settings: CodemodeSettings.nullable(),
    /** Pi's global `settings.json` lists `-builtin:codemode` in `extensions`: code mode is off whatever the choice (MC46). */
    codemodeBuiltinOff: z.boolean(),
  })
  .strict();
export type McpOverview = z.infer<typeof McpOverview>;

const Scope = z.enum(["global", "project"]);
/** Set by the browser after "Save anyway?": a project's `.pi/` files can run commands later (M7R133). */
const ConfirmProtected = z.boolean().optional();
const ServerRef = z.object({ scope: Scope, name: Name }).strict();
const WRITE_EXPOSURES = z.enum(["codemode", "deferred", "direct", "hidden"]);
/** What a refused row of a group switch says; the others of the group were switched (M7R88). */
export const McpRowCode = z.enum(["not_found", "invalid_name", "invalid_entry", "write_failed"]);
export type McpRowCode = z.infer<typeof McpRowCode>;
const MAX_ENTRY_TEXT = 262_144;

/** The params every write method shares with its helper operation: the helper gets `cwd` from the run, not from here. */
export const McpWriteParams = {
  setEnabled: z
    .object({
      servers: z.array(ServerRef).min(1).max(MCP_LIMITS.servers),
      enabled: z.boolean(),
      confirmProtected: ConfirmProtected,
    })
    .strict(),
  setExposure: z
    .object({ scope: Scope, name: Name, exposure: WRITE_EXPOSURES, confirmProtected: ConfirmProtected })
    .strict(),
  setInProject: z.object({ name: Name, enabled: z.boolean(), confirmProtected: ConfirmProtected }).strict(),
  remove: z.object({ scope: Scope, name: Name, confirmProtected: ConfirmProtected }).strict(),
  restore: z
    .object({
      scope: Scope,
      name: Name,
      index: z.number().int().min(0).max(MCP_LIMITS.servers),
      entry: z.string().min(2).max(MAX_ENTRY_TEXT),
      confirmProtected: ConfirmProtected,
    })
    .strict(),
  // The entry is parsed by the browser (M7R91) and validated in the helper with `McpEntry`; it may hold literal secrets.
  add: z
    .object({
      scope: Scope,
      name: Name,
      entry: z.record(z.string(), z.unknown()),
      confirmProtected: ConfirmProtected,
    })
    .strict(),
  codemode: z
    .object({
      choice: z.enum(["automatic", "always"]).optional(),
      mode: z.enum(["on", "only"]).optional(),
      inlineBudget: z.number().int().min(0).max(1_000_000).nullable().optional(),
    })
    .strict(),
};

export const McpSetEnabledResult = z
  .object({
    results: z
      .array(z.object({ scope: Scope, name: Name, ok: z.boolean(), code: McpRowCode.optional() }).strict())
      .max(MCP_LIMITS.servers),
  })
  .strict();
export type McpSetEnabledResult = z.infer<typeof McpSetEnabledResult>;
export const McpRemoveHelperResult = z
  .object({ index: z.number().int().min(0).max(MCP_LIMITS.servers), entry: z.string().max(MAX_ENTRY_TEXT) })
  .strict();

/** What a Test answers at most (M7R93, M7R95): tool names are listed to 200, each clipped, the notice masked and clipped. */
export const MCP_TEST_LIMITS = { tools: 200, toolName: 128, message: 512 } as const;
/** The classified outcome of a Test: it holds no stderr and no raw notice, only the masked, clipped message (M7R95). */
export const McpTestOutcome = z
  .object({
    state: McpTestState,
    tools: z.array(z.string().max(MCP_TEST_LIMITS.toolName)).max(MCP_TEST_LIMITS.tools),
    toolsTruncated: z.boolean(),
    message: z.string().max(MCP_TEST_LIMITS.message).nullable(),
  })
  .strict();
export type McpTestOutcome = z.infer<typeof McpTestOutcome>;
export const McpTestResult = McpTestOutcome.extend({ at: z.number() }).strict();
export type McpTestResult = z.infer<typeof McpTestResult>;
/** The helper's params: the deadline is the daemon's (the module's Test deadline), so a test can shorten it. */
export const McpTestHelperParams = z
  .object({ scope: Scope, name: Name, deadlineMs: z.number().int().min(1).max(120_000) })
  .strict();

const Ok = z.object({ ok: z.literal(true) }).strict();
const Cwdn = Cwd.optional();
const WRITE_ERRORS = [
  "bad_request",
  "protected_path",
  "invalid_cwd",
  "not_found",
  "forbidden",
  "capacity",
  "timeout",
  "helper_failed",
  "config_invalid",
  "config_path_refused",
  "config_hard_link",
] as const;

export const mcpMethods = {
  "mcp.overview": defineMethod({
    name: "mcp.overview",
    // pi:admin (MC38): the views hold masked command lines, URLs and variable names; masking is heuristic, so browser
    // sessions only, never a token.
    permission: "pi:admin",
    idempotent: true,
    // `cwd` must be a folder the caller has a session or project in, else `invalid_cwd` (like models.overview, M7R50).
    params: z.object({ cwd: Cwd.optional() }),
    result: McpOverview,
    errors: ["invalid_cwd", "capacity", "timeout", "helper_failed"],
  }),
  // Writes (Task 18). pi:admin: browser sessions only, never a token (M7R133). A project row needs `confirmProtected`
  // (`protected_path` without it); `forbidden` is also an untrusted project. `timeout`: whether the file changed is unknown.
  "mcp.setEnabled": defineMethod({
    name: "mcp.setEnabled",
    permission: "pi:admin",
    idempotent: false,
    params: McpWriteParams.setEnabled.extend({ cwd: Cwdn }),
    result: McpSetEnabledResult,
    errors: WRITE_ERRORS,
  }),
  "mcp.setExposure": defineMethod({
    name: "mcp.setExposure",
    permission: "pi:admin",
    idempotent: false,
    params: McpWriteParams.setExposure.extend({ cwd: Cwdn }),
    result: Ok,
    errors: WRITE_ERRORS,
  }),
  "mcp.setInProject": defineMethod({
    name: "mcp.setInProject",
    permission: "pi:admin",
    idempotent: false,
    params: McpWriteParams.setInProject.extend({ cwd: Cwd }),
    result: Ok,
    errors: WRITE_ERRORS,
  }),
  "mcp.remove": defineMethod({
    name: "mcp.remove",
    permission: "pi:admin",
    idempotent: false,
    params: McpWriteParams.remove.extend({ cwd: Cwdn }),
    // The token takes the removed entry back for `expiresInMs` (M7R90). `limit_reached`: 100 removals are waiting.
    result: z
      .object({ token: z.string().min(1).max(128), expiresInMs: z.number().int().positive() })
      .strict(),
    errors: [...WRITE_ERRORS, "limit_reached"],
  }),
  "mcp.undo": defineMethod({
    name: "mcp.undo",
    permission: "pi:admin",
    idempotent: false,
    params: z.object({ token: z.string().min(1).max(128), confirmProtected: ConfirmProtected }).strict(),
    // A global undo takes the password step-up: it brings a command back into Pi's own config (M7R133).
    result: Ok,
    errors: [...WRITE_ERRORS, "step_up_required", "conflict"],
  }),
  "mcp.add": defineMethod({
    name: "mcp.add",
    permission: "pi:admin",
    idempotent: false,
    // The entry can hold literal env or header secrets: the receipt hashes the selector fields only (MC30).
    sensitiveParams: ["scope", "name", "cwd"],
    params: McpWriteParams.add.extend({ cwd: Cwdn }),
    // A global add takes the password step-up (M7R133). `conflict`: the name exists. `bad_request`: not a valid entry.
    result: Ok,
    errors: [...WRITE_ERRORS, "step_up_required", "conflict", "bad_request"],
  }),
  "mcp.setCodemode": defineMethod({
    name: "mcp.setCodemode",
    permission: "pi:admin",
    idempotent: false,
    params: McpWriteParams.codemode,
    result: CodemodeSettings,
    errors: [
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
      "config_hard_link",
    ],
  }),
  // Runs what the file says for that name, in a throwaway session (M7R93): pi:admin and the password step-up, since it starts
  // a command or opens a connection. `forbidden`: the project is not trusted (M7R94). Params name the server; no secret.
  "mcp.test": defineMethod({
    name: "mcp.test",
    permission: "pi:admin",
    idempotent: false,
    params: z.object({ scope: Scope, name: Name, cwd: Cwdn }).strict(),
    result: McpTestResult,
    errors: [
      "step_up_required",
      "bad_request",
      "invalid_cwd",
      "not_found",
      "forbidden",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
      "config_hard_link",
    ],
  }),
};
