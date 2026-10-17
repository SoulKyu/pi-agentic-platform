# ADR 0051: agents in the Inbox

Status: accepted (M11a, Task 28)
Date: 2026-10-16
Spec: C §6.4. Rulings: M11R89 to M11R92, M11R100 to M11R102, M11R107, W5-R48. Owner decision 29 (board 09).

## Context

M10's Inbox holds the questions and the endings of automation tasks (ADR 0041). An agent adds things the owner must see or answer: a notification, an approval it asks for, a secret it asks for, a reply waiting in its thread, the result of a delegation. They must not become a second list, and an agent's words must stay data.

## Decision

- M11 extends M10's table `inbox_items` with four columns (`agent_id`, `ref_id`, `entry_id`, `detail`) and a unique index on `(ref_id, kind)`. An item is one row per request or agent and kind; a new event of the same kind reopens the row rather than adding one (an upsert that only touches the owner's own row).
- Kinds (`INBOX_KINDS`, contracts):
  - to handle: `task_needs_input` (M10), `agent_approve`, `secret_request`, and `memory_review` (the kind is listed; nothing writes it before M11b);
  - replies: `agent_reply` and `delegation_done`;
  - tasks: `task_done`, `task_failed`, `task_interrupted`, `task_limited` (M10);
  - info: `agent_notify`.
- Filters (`inbox.list {filter}`): All, To handle, Replies, Tasks. The kinds of the groups do not overlap; an item with an `agentId` shows as an agent row whatever its kind.
- A request is a row. `agent_approve` and `secret_request` items are written with the request (`ref_id` = the request id) and resolved when it ends (answered, denied, expired, cancelled, declined). A boot expires every request still pending, because the worker that asked is gone. There is no answer path in the Inbox service: the owner answers through `agents.answerApproval`, `secrets.answerRequest` or `secrets.declineRequest`, which are browser-only.
- `agent_reply` appears when the agent's unread count rises (a completed thread run, a card, a notification) and is resolved when the owner marks the thread read. A thread reset clears it. Closing it also marks it read, so the unread badge clears (W5-R48: `resolveRef` reads an info item as it closes it); a to-handle item keeps M10's behaviour, answering it does not read it.
- `agent_notify` (`agent_notify` tool, 30 an hour per agent): an info item with the stripped one-line text, and a solid "notification" card in the thread. If the Inbox is full the card is still written and a warning is logged.
- `detail` is one short line the agent or a fact wrote: control, format, line and paragraph separator characters removed, whitespace collapsed, cut to 500 UTF-16 units without splitting a pair, shown as text only. The stored title is a fixed label (`agent`); the client builds the sentence the owner reads from the kind and the agent's name, so the agent's words are never the title. A ref, entry or agent id outside its length bounds is refused before SQL and logged `inbox_agent_item_refused`.
- Owner scoping is twice: the port refuses a `(ref_id, kind)` pair that another owner's row holds, and the SQL upsert only updates a row of the same owner.
- M10's retention applies: 2 000 per owner, read info rows evicted first, a to-handle row always written. Deleting an agent removes its items.
- The Inbox drawer shows an agent row with the agent's avatar, pap's sentence, the detail as untrusted text and the age. A click opens the agent's tab at the entry. An open `agent_approve` row carries Approve and Deny; an open `secret_request` row carries Provide and Decline. Provide opens a dialog with a masked field; the value is in that call only, never in a store, URL, log or storage.

## Consequences

- One Inbox, one badge. The to-handle count includes approvals and secret requests.
- A request the daemon restarted under is shown as expired, not lost.
- `memory_review` rows arrive with M11b; a build that knows the kind but not the writer shows none.
