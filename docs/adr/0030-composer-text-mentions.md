# ADR 0030 — The composer keeps plain text: `@` mentions are text, `$skill` is Pi's `/skill:name`

Status: accepted (owner c2, 2026-10-13) · Date: 2026-10-14 · Spec: C §7.2 (deviation: the composer row of the web table) · Rulings: M8R83-M8R86, M8R89, M8R113

## Context

Spec C §7.2 names tiptap for the composer, with chips for `@file`, `$skill`, `/command` and `@Agent`. M8 needs `@` mentions, dropped and pasted files, and an Attach button; M7 needs a `/` and `$` menu for commands and skills. A rich editor would restructure the composer in both milestones at once, and it adds an editor framework to the initial bundle (decision 75 keeps the ceiling at 300 KB).

## Decision

- The composer field stays a `TextField` (a `textarea`). Nothing is parsed out of it on send: what the person sees is what Pi gets.
- `@path` is text. The menu follows the caret's `@query` (`features/sessions/composer/use-mentions.ts`), asks `files.search` rooted at the session's project (debounce 150 ms, 8 results), and inserts the path relative to the session's folder (`mention.vm.ts`). A row dragged from the explorer inserts the same text (`dropPath`, drag type `application/x-pap-path`, M8R77).
- M7's `$skill` is sent as Pi's own `/skill:name`, which Pi expands itself.
- Every menu of the field shares one key path: `ComposerMenu` (`open`, `close`, `onKeyDown`, `combobox`) and the hook `useComposerFieldProps(menus, attachments)` in `composer/menus.ts`. The first open menu handles the keys, the field has one `combobox`, and a second menu that opens is closed (M8R113, MC37). M7's `useComposerCommands` joins the array.
- `TextField` gains the optional props the key path needs (`inputRef`, `onKeyDown`, `onPaste`, `onDrop`, `onDragOver`, `combobox`, M8R83).
- Pasted and dropped files are attachments (ADR 0031). Pasted text stays text: when a clipboard holds both, the text wins (`pastedFiles` in `composer/drop.ts`).

## Consequences

- No new dependency and no rewrite of the composer in this wave; the menu chain and the attachment tray load with the session chunk.
- A mention is not a link: renaming the file afterwards leaves stale text, and the agent reads whatever path the text names. Names go through the same untrusted-text rules as every file name (bidi and zero-width characters stripped for display).
- Chips (a structured mention that survives editing, `@Agent`, `/command` inline) are revisited at M11, when the agent roster exists. The cost is a replacement of the field and its menus, not of their daemon calls.
