# ADR 0028: tool presets, Chat only and the read-only preset rule

Status: accepted (M7, Task 15)

## Context

pi-web lets the owner pick which of Pi's coding tools a session has. pap does the same, and the read-only preset is enforced where tool calls are judged, not only in the menu. What it promises is exact: Pi's coding tools that change things are unavailable, an MCP tool that may change things is blocked, and any other tool whose category is not `read` is never run unasked (no grant or always rule skips the question). It is not a promise that no extension tool can change anything: an extension tool the owner allows once runs. Pi also has tools no preset lists (MCP, codemode, `tool_search`, extension tools), and two indirect ways to reach a tool that is not in the active set: codemode scripts call tools through `ctx.executeTool`, and `tool_search` activates tools.

## Decision

- Presets: `none` (no coding tool), `read-only` (read grep find ls), `default` (read bash edit write), `full` (those and grep find ls), `configured` (Pi's `defaultTools`, nothing pinned) and `chat` (no tool, and a worker opened with `noExtensions`, `noSkills`, `noPromptTemplates` and none of the MCP, codemode and tool-search built-ins). `chat` still loads pap-policy and the other inline factories: Pi drops only the user's extensions and its own built-ins under `noExtensions` (pinned by `host.presets.int.test.ts`).
- The preset is pap's. It is stored in `sessions.tool_preset` (NULL is `configured`; the CHECK refuses anything else), sent in `InitRecord.tools`, and never written to Pi's transcript. A value this version cannot read is treated as `chat`, the narrowest preset; a worker refuses an init with a preset it does not know.
- A preset replaces only the coding tools. The active set becomes the preset's names plus every active tool that is not a coding tool, so an extension tool its extension switched off stays off. The worker re-applies the preset at `session_start` (reload, resume), `session_tree`, `before_agent_start` and `turn_start`, and after `navigate_tree`.
- `sessions.setTools` (`sessions:operate`, mutation) changes a live session in place when it is idle (`session_busy` otherwise, from the daemon's view and again from the worker's) and neither the old nor the new preset is `chat`. Crossing the `chat` boundary stores the preset and releases the worker; the next start opens with it. A cold session only stores it. Nothing is stored when the worker refuses. A fork or clone takes its source's preset, like its mode and taint.
- Enforcement is in the worker's policy (stage 02), by name, whatever reached the call:
  - A coding tool the preset leaves out is blocked ("tool not in the session's preset"), so codemode's nested calls and anything `tool_search` or a rewritten transcript puts back into the active set cannot use it. The active set is the model's tool list; it is not the gate.
  - Under `read-only` the MCP read-only rule of the read-only approval mode applies whatever the mode: an MCP tool without `readOnlyHint: true`, codemode calls included, is blocked (`PolicyRules.readOnlyPreset`).
  - Under `read-only` a call whose category is not `read` is never run unasked, in every approval mode, `full-access` included (MC36): `unknown` extension tools, and an extension registered under a built-in's name (classified by source, so `unknown`) are asked with Deny / Allow once, and no grant skips the question (`stage-approval.ts`). Pi's own `read`, `grep`, `find` and `ls` run as in the mode. Where nobody can be asked the call is blocked. The read-only approval mode still blocks `unknown`.
  - The worker adds its own preset to the rules it judges with (`readOnlyPreset` OR-ed, `presetTools` set by the worker alone), so a rules update that is late or lost cannot loosen a preset that was applied. The daemon composes `readOnlyPreset` from the stored preset and pushes the rules after a change.
- A preset takes effect for the next turn: `set_tools` is refused while a run goes on, and the policy reads the preset at each call, so a turn in flight keeps what it had.

## Consequences

- `none` and `chat` are not read-only presets: MCP tools that may change things stay usable under `none`. `chat` has no MCP at all.
- A tool an extension registers under a coding tool's name is blocked under a preset that leaves that name out, as the built-in would be.
- A cold session has no loadout, so the stored preset travels in the session summary the list and the shell read (`SessionSummary.toolPreset`, `contracts/src/shell.ts:55`; absent from an older daemon) and in the snapshot when no worker runs (`snapshot.ts:151`, "configured" when nothing is stored); the chip shows it (MC37).
- Under `read-only`, extension tools stay active and are asked, not blocked (the owner's balance between security and use); only MCP has a read-only hint to judge by. An allowed extension tool can still change things.
- The MCP `readOnlyHint` is the server's own claim, trusted from a server the owner configured; a server that marks a writing tool read-only passes. Same trust as the read-only approval mode (M5, M7R78).
