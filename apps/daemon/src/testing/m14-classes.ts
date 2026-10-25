import type { MethodName } from "@pap/contracts";
import type { OwnerSeeds } from "./two-users.ts";
import { CANARY } from "./two-users.ts";

/** What a member meets in a method (M14 J1). A method in none of the lists fails the typecheck (`Unclassified`). */
export type Class = "member-own" | "member-forbidden" | "shared-read";

/** `memberDenied`: `system:admin`, `pi:*`, `users:*` and `lanes:*`. One call with `{}` answers `forbidden`, before the params parse. */
export const FORBIDDEN = [
  ...["github.startCreate", "github.forget", "fonts.add", "fonts.remove", "trust.status", "trust.set"],
  ...["models.available", "models.config.get", "models.config.save", "models.extensions", "models.discover"],
  ...[
    "models.test",
    "models.pricing",
    "models.provider.get",
    "models.provider.save",
    "models.provider.remove",
  ],
  ...[
    "models.usage",
    "models.overview",
    "models.setDefault",
    "models.setDefaultThinking",
    "models.setEnabled",
  ],
  ...[
    "models.refreshCatalog",
    "models.login",
    "models.loginAnswer",
    "models.loginCancel",
    "models.cancelLogin",
  ],
  ...[
    "subscribe.login",
    "models.setApiKey",
    "models.logout",
    "mcp.overview",
    "mcp.setEnabled",
    "mcp.setExposure",
  ],
  ...["mcp.setInProject", "mcp.remove", "mcp.undo", "mcp.add", "mcp.setCodemode", "mcp.test"],
  ...[
    "skills.list",
    "skills.setInvocation",
    "skills.search",
    "skills.install",
    "plugins.list",
    "plugins.install",
  ],
  ...["plugins.remove", "plugins.update", "plugins.setEnabled", "subscribe.lane", "lanes.preview"],
  ...["lanes.listArchived", "lanes.refresh", "lanes.scriptLog", "lanes.turns", "lanes.review"],
  ...["lanes.reviewState.get", "lanes.checkpointStatus", "lanes.compare", "lanes.create", "lanes.newSession"],
  ...[
    "lanes.commit",
    "lanes.suggestCommit",
    "lanes.reviewState.set",
    "lanes.approveScripts",
    "lanes.runScript",
  ],
  ...["lanes.restore", "lanes.issue", "lanes.push", "lanes.prCreate", "lanes.prRefresh", "lanes.archive"],
  ...["lanes.closeLosers", "users.list", "users.invite", "users.revokeInvite", "users.setBudget"],
  ...["users.setDisabled", "users.delete", "users.providers", "users.setProviderShared"],
] as const;

/** Read by every user, each answer made of the caller's own view or of install-wide facts. Value: the exact result keys. */
export const SHARED_READ = {
  "fonts.list": ["families"],
  "push.config": [
    "keysReset",
    "lastFailure",
    "max",
    "publicKey",
    "readiness",
    "reason",
    "status",
    "subscribed",
  ],
  "agents.vmStatus": ["agents", "claudeToken", "host", "reason", "usable", "vmdVersion"],
  "sessions.availableModels": ["models", "origin", "providerIds", "providers", "truncated"],
  "agents.packages": ["packages"],
  "github.status": ["status"],
  "ops.events.list": ["events", "hasMore"],
} as const satisfies Record<string, readonly string[]>;

/** Params that name nothing of the owner's: the answer is the member's own, or empty. */
export const NO_FOREIGN_INPUT = {
  "settings.get": { key: "appearance" },
  "sessions.listArchived": {},
  "projects.scratch": {},
  "projects.create": { name: "Mine" },
  "github.authorizeUrl": {},
  "github.disconnect": {},
  "github.repositories": {},
  "auth.tokens.list": {},
  "auth.tokens.create": { name: "extra", permissions: ["sessions:read"], expiresInDays: 7 },
  "auth.devices.list": {},
  "auth.passkeys.list": {},
  "policy.getSettings": {},
  "automation.triggers.list": {},
  "usage.summary": { range: "7d" },
  "inbox.list": {},
  "agents.list": {},
  "agents.trash": {},
  "push.list": {},
  "push.test": {},
  "push.presence": { focused: true },
  "system.ping": {},
  unsubscribe: { sub: "none" },
  "sessions.list": {},
  "subscribe.shell": {},
  "subscribe.terminal": {},
  "subscribe.tasks": {},
  "subscribe.usage": {},
  "subscribe.inbox": {},
  "subscribe.agents": {},
  "subscribe.ops": {},
  "agents.vm.clearClaudeToken": {},
  "auth.devices.revokeOthers": {},
} as const satisfies Record<string, object>;

export interface Probe {
  /** The params, built from the owner's rows. */
  readonly params: (s: OwnerSeeds) => object;
  /** The call may answer ok with nothing in it (a search that finds nothing): never with the owner's row. */
  readonly empty?: true;
  /** A refusal that is not the owner's row either: no App is connected, so the repository is never looked up. */
  readonly also?: string;
}

const owned = (s: OwnerSeeds) => ({ projectId: s.project.id });
const session = (s: OwnerSeeds) => ({ sessionId: s.sessionId });
const trigger = (s: OwnerSeeds) => ({ triggerId: s.triggerId });
const agent = (s: OwnerSeeds) => ({ agentId: s.agentId });
const root = (s: OwnerSeeds) => ({ root: s.project.root });
const sha = "a".repeat(40);
const newAgent = {
  name: "Intruder",
  mode: "full-access",
  preset: "full",
  sandbox: { required: true, network: false },
};

/** Methods whose params can name a row of the owner's: a member's call answers `not_found` or `forbidden`, or nothing. */
export const PROBES = {
  "search.query": { params: () => ({ q: CANARY.file }), empty: true },
  "projects.add": { params: (s) => ({ root: s.project.root }) },
  "projects.update": { params: (s) => ({ ...owned(s), change: { kind: "rename", name: "Taken" } }) },
  "projects.knowledge": { params: owned },
  "projects.enableKnowledge": { params: owned },
  "sessions.mark": { params: (s) => ({ ...session(s), change: { kind: "archive" } }) },
  "projects.delete": { params: owned },
  "projects.box": { params: owned },
  "projects.setBox": { params: owned },
  "projects.startBox": { params: owned },
  "projects.restartBox": { params: owned },
  "projects.rebuild": { params: owned },
  "projects.createFromGithub": {
    params: () => ({ repository: "acme/secret", mode: "clone" }),
    also: "github_unavailable",
  },
  "projects.linkGithub": { params: (s) => ({ ...owned(s), repository: "acme/secret" }) },
  "projects.unlinkGithub": { params: owned },
  "projects.cloneAgain": { params: owned },
  "projects.commitPush": { params: (s) => ({ ...owned(s), message: "take over" }) },
  "projects.prCreate": { params: (s) => ({ ...owned(s), title: "t", body: "b" }) },
  "projects.github": { params: owned },
  "projects.checkLog": { params: (s) => ({ ...owned(s), checkId: "1" }) },
  "projects.sendToSession": { params: (s) => ({ ...owned(s), source: { kind: "issue", number: 1 } }) },
  "audit.list": { params: session, empty: true },
  "sessions.commands": { params: session },
  "subagents.profiles": { params: session },
  "auth.tokens.revoke": { params: (s) => ({ tokenId: s.tokenId }) },
  "auth.devices.revoke": { params: (s) => ({ deviceId: s.deviceId }) },
  "auth.passkeys.remove": { params: () => ({ passkeyId: "pk-of-the-owner" }) },
  "files.list": { params: (s) => ({ path: s.project.root }) },
  "files.read": { params: (s) => ({ path: s.filePath }) },
  "files.search": { params: (s) => ({ root: s.project.root, query: "canary" }) },
  "files.write": { params: (s) => ({ path: s.filePath, text: "overwritten", baseEtag: null }) },
  "subscribe.vcs": { params: root },
  "vcs.refresh": { params: root },
  "vcs.fileDiff": {
    params: (s) => ({ ...root(s), path: "canary.txt", from: { kind: "head" }, to: { kind: "worktree" } }),
  },
  "terminal.create": {
    params: (s) => ({ requestId: "r".repeat(26), cwd: s.project.root, cols: 80, rows: 24 }),
  },
  "terminal.attach": { params: (s) => ({ terminalId: s.terminalId }) },
  "terminal.detach": { params: () => ({ streamId: 1 }), empty: true },
  "terminal.resize": { params: (s) => ({ terminalId: s.terminalId, cols: 90, rows: 30 }) },
  "terminal.close": { params: (s) => ({ terminalId: s.terminalId }), empty: true },
  "policy.setSettings": {
    params: () => ({ value: { defaultMode: "supervised" }, baseRevision: 0 }),
    empty: true,
  },
  "policy.listRules": { params: (s) => ({ cwd: s.project.root }), empty: true },
  "policy.setSessionMode": { params: (s) => ({ ...session(s), mode: null }) },
  "policy.clearTaint": { params: session },
  "policy.revokeRule": { params: () => ({ ruleId: "rule-of-the-owner" }) },
  "sessions.models": { params: session },
  "sessions.setModel": { params: (s) => ({ ...session(s), provider: "acme", modelId: "m-1" }) },
  "sessions.setThinking": { params: (s) => ({ ...session(s), level: "high" }) },
  "sessions.setTools": { params: (s) => ({ ...session(s), preset: "full" }) },
  "settings.set": { params: () => ({ key: "appearance", value: {}, baseRevision: 0 }), empty: true },
  "automation.triggers.get": { params: trigger },
  "automation.triggers.create": {
    params: (s) => ({
      input: {
        name: "Intruder",
        enabled: true,
        source: { type: "manual" },
        execution: { cwd: s.project.root, tools: ["read"] },
        prompt: "Do it.",
      },
    }),
  },
  "automation.triggers.update": {
    params: (s) => ({
      ...trigger(s),
      baseRevision: 1,
      input: { name: "Taken", source: { type: "manual" }, execution: { cwd: s.project.root }, prompt: "x" },
    }),
  },
  "automation.triggers.delete": { params: trigger },
  "automation.triggers.setEnabled": { params: (s) => ({ ...trigger(s), enabled: false }) },
  "automation.triggers.rotateSecret": { params: trigger },
  "automation.tasks.cancel": { params: (s) => ({ taskId: s.taskId }) },
  "automation.tasks.retry": { params: (s) => ({ taskId: s.taskId }) },
  "automation.tasks.releaseTools": { params: (s) => ({ taskId: s.taskId }) },
  "automation.fire": { params: trigger },
  "automation.dryRun": { params: trigger },
  "automation.journal": { params: trigger },
  "automation.failures.dismiss": { params: () => ({ effectId: 1 }) },
  "usage.resumeNow": { params: session },
  "usage.cancelResume": { params: session },
  "inbox.markRead": { params: (s) => ({ ids: [s.inboxId] }), empty: true },
  "agents.get": { params: agent },
  "agents.create": { params: () => ({ input: newAgent }), empty: true },
  "agents.update": {
    params: (s) => ({ ...agent(s), baseRevision: 1, input: { ...newAgent, name: "Taken" } }),
  },
  "agents.delete": { params: agent },
  "agents.openThread": { params: agent },
  "agents.resetThread": { params: agent },
  "agents.markRead": { params: agent },
  "agents.events": { params: agent },
  "agents.setPaused": { params: (s) => ({ ...agent(s), paused: true }) },
  "agents.status": { params: agent },
  "agents.queueTask": { params: (s) => ({ ...agent(s), prompt: "do it" }) },
  "agents.answerApproval": { params: () => ({ requestId: "request-of-the-owner", approved: true }) },
  "agents.quarantine": { params: agent },
  "agents.permissions": { params: agent },
  "agents.prompts": { params: agent },
  "agents.prompt": { params: (s) => ({ ...agent(s), name: "base.md" }) },
  "agents.vm.setClaudeToken": {
    params: () => ({ token: "sk-ant-oat01-MEMBER-OWN-TOKEN-0123456789" }),
    empty: true,
  },
  "agents.purgeTrash": { params: agent },
  "agents.files.list": { params: agent },
  "agents.files.remove": { params: (s) => ({ ...agent(s), path: "notes.md" }) },
  "secrets.list": { params: agent },
  "secrets.set": { params: (s) => ({ ...agent(s), name: "TAKEN", value: "value-of-the-member" }) },
  "secrets.delete": { params: (s) => ({ ...agent(s), name: "TAKEN" }) },
  "secrets.answerRequest": {
    params: () => ({ requestId: "request-of-the-owner", value: "v", mode: "once" }),
  },
  "secrets.declineRequest": { params: () => ({ requestId: "request-of-the-owner" }) },
  "subagents.cancel": { params: () => ({ runId: "run-of-the-owner" }) },
  "push.subscribe": {
    params: () => ({
      subscription: {
        endpoint: "https://push.example.net/send/journey",
        keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
        locale: "en",
        label: "journey",
      },
    }),
    // The endpoint host is not one of the push vendors the daemon accepts: bad_request, whoever asks.
    also: "bad_request",
    empty: true,
  },
  "push.revoke": { params: () => ({ id: "p".repeat(22) }) },
  "push.open": { params: () => ({ id: "p".repeat(22) }) },
  "sessions.create": { params: (s) => ({ cwd: s.project.root }) },
  "sessions.prompt": { params: (s) => ({ ...session(s), text: "hello" }) },
  "sessions.reopen": { params: session },
  "sessions.abort": { params: session },
  "sessions.clearQueue": { params: session },
  "sessions.navigate": { params: (s) => ({ ...session(s), targetId: sha }) },
  "sessions.compact": { params: session },
  "sessions.rename": { params: (s) => ({ ...session(s), name: "Taken" }) },
  "sessions.autoName": { params: session },
  "sessions.exportHtml": { params: session },
  "sessions.fork": { params: (s) => ({ ...session(s), entryId: sha }) },
  "sessions.clone": { params: session },
  "sessions.respondDialog": {
    params: (s) => ({ ...session(s), dialogId: "d1", response: { confirmed: true } }),
  },
  "sessions.panelInput": { params: (s) => ({ ...session(s), panelId: "p1", data: "x" }) },
  "sessions.history": { params: (s) => ({ ...session(s), before: sha }) },
  "sessions.toolOutput": { params: (s) => ({ ...session(s), toolCallId: "t1" }) },
  "sessions.branches": { params: session },
  "subscribe.session": { params: session },
} as const satisfies Record<string, Probe>;

type Classified =
  (typeof FORBIDDEN)[number] | keyof typeof SHARED_READ | keyof typeof NO_FOREIGN_INPUT | keyof typeof PROBES;
/** `never` while every method is classified; a new method makes this a type error until it is put in a list. */
type Unclassified = Exclude<MethodName, Classified>;
export const ALL_CLASSIFIED: [Unclassified] extends [never] ? true : Unclassified = true;

/** The class of every method, as the brief asks: `Record<MethodName, Class>`. */
export const METHOD_CLASS: Record<MethodName, Class> = Object.fromEntries([
  ...FORBIDDEN.map((name) => [name, "member-forbidden"]),
  ...Object.keys(SHARED_READ).map((name) => [name, "shared-read"]),
  ...Object.keys(NO_FOREIGN_INPUT).map((name) => [name, "member-own"]),
  ...Object.keys(PROBES).map((name) => [name, "member-own"]),
]) as Record<MethodName, Class>;

/** The Hono routes (`METHOD path`, middleware excluded) and how a member meets each. */
export type RouteClass = "public" | "session-own" | "owner-only" | "own-flow" | "callback" | "shared-read";
export const ROUTE_CLASS: Record<string, RouteClass> = {
  "GET /healthz": "public",
  "GET /auth/status": "public",
  "POST /auth/setup": "public",
  "POST /auth/login": "public",
  "POST /auth/confirm": "own-flow",
  "POST /auth/logout": "own-flow",
  "POST /auth/passkey/register/options": "own-flow",
  "POST /auth/passkey/register/verify": "own-flow",
  "POST /auth/passkey/login/options": "public",
  "POST /auth/passkey/login/verify": "public",
  "POST /auth/invite/info": "public",
  "POST /auth/invite/accept": "public",
  "GET /files/raw": "session-own",
  "PUT /files/raw": "session-own",
  "POST /upload": "session-own",
  "PUT /agent-files": "session-own",
  "GET /api/sessions/:sessionId/export/:token": "session-own",
  "POST /hooks/:id": "public",
  "GET /fonts/:slug/:file": "shared-read",
  "GET /github/app/new": "owner-only",
  "GET /github/app/authorize": "own-flow",
  "GET /github/app/created": "callback",
  "GET /github/app/authorized": "callback",
  "GET /github/app/authorized/finish": "own-flow",
  "GET /ws": "public",
};
