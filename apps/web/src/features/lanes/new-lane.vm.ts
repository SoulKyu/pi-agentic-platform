import {
  BranchName,
  type IssueView,
  LANE_LIMITS,
  LaneTitle,
  type LanePreview,
  type ModelPick,
  type ModelsOverview,
  slugOf,
} from "@pap/contracts";
import { issueUrl, parseIssueUrl } from "./issue-url.ts";

/** The "From" choice that means the checkout's own HEAD: nothing is sent and the daemon takes HEAD. */
export const HEAD_BASE = "head";

export interface Slot {
  readonly key: number;
  /** `null`: Pi's default model. */
  readonly model: ModelPick | null;
}

/** What the person typed, with the two prefills that stay theirs once edited (title, branch). */
export interface Draft {
  readonly text: string;
  readonly title: string;
  readonly titleEdited: boolean;
  readonly branch: string;
  readonly branchEdited: boolean;
  readonly base: string;
  readonly slots: readonly Slot[];
  readonly issue: IssueView | null;
}

export const emptyDraft = (): Draft => ({
  text: "",
  title: "",
  titleEdited: false,
  branch: "",
  branchEdited: false,
  base: HEAD_BASE,
  slots: [{ key: 0, model: null }],
  issue: null,
});

/** The draft "Run again" opens with: the prompt or issue link and a slot per model. The branch is left to the daemon. */
export function prefillDraft(text: string, models: ReadonlyArray<ModelPick | null>): Draft {
  const slots = models.slice(0, LANE_LIMITS.fanout).map((model, key) => ({ key, model }));
  const draft = withText(emptyDraft(), text, "");
  return { ...draft, branch: "", slots: slots.length === 0 ? draft.slots : slots };
}

const clip = (value: string): string => [...value].slice(0, LANE_LIMITS.title).join("");

/** The title a description or an issue suggests: the issue's title, else the first line (none for a link not fetched yet). */
function suggestedTitle(text: string, issue: IssueView | null): string {
  if (issue !== null) return clip(issue.title.trim());
  if (parseIssueUrl(text) !== null) return "";
  return clip(
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "",
  );
}

const suggestedBranch = (prefix: string, title: string): string =>
  title.trim() === "" ? "" : `${prefix}${slugOf(title)}`;

/** Re-derives what the person has not edited. */
function refill(draft: Draft, prefix: string): Draft {
  const title = draft.titleEdited ? draft.title : suggestedTitle(draft.text, draft.issue);
  const branch = draft.branchEdited ? draft.branch : suggestedBranch(prefix, title);
  return { ...draft, title, branch };
}

/** An issue stays only while the text is still its link. */
const keepsIssue = (text: string, issue: IssueView | null): boolean => {
  const ref = parseIssueUrl(text);
  return issue !== null && ref !== null && issueUrl(ref) === issue.url;
};

export function withText(draft: Draft, raw: string, prefix: string): Draft {
  const text = raw.slice(0, LANE_LIMITS.description);
  return refill({ ...draft, text, issue: keepsIssue(text, draft.issue) ? draft.issue : null }, prefix);
}

/** An answer is applied only while the field still holds the link that was fetched (the text may change during the call). */
export const withIssue = (draft: Draft, issue: IssueView, prefix: string): Draft =>
  keepsIssue(draft.text, issue) ? refill({ ...draft, issue }, prefix) : draft;

export const withTitle = (draft: Draft, title: string, prefix: string): Draft =>
  refill({ ...draft, title, titleEdited: true }, prefix);

export const withBranch = (draft: Draft, branch: string): Draft => ({ ...draft, branch, branchEdited: true });

/** An empty branch is left to the daemon; anything else must be a name `BranchName` takes. */
export const branchProblem = (branch: string): boolean =>
  branch !== "" && !BranchName.safeParse(branch).success;

export const canCreate = (draft: Draft): boolean =>
  LaneTitle.safeParse(draft.title).success &&
  (draft.text.trim() !== "" || draft.issue !== null) &&
  !branchProblem(draft.branch);

export interface BaseOption {
  readonly value: string;
  readonly label: string;
}

/** The current branch (HEAD) first, then the preview's refs, newest first, without the current branch twice. */
export function baseOptions(preview: LanePreview, headLabel: string): BaseOption[] {
  const own = preview.current === null ? null : `refs/heads/${preview.current}`;
  return [
    { value: HEAD_BASE, label: headLabel },
    ...preview.refs.filter((ref) => ref.ref !== own).map((ref) => ({ value: ref.ref, label: ref.label })),
  ];
}

/** The daemon's lineage answer for the picked base: a commit that is not HEAD or one of its ancestors is not the owner's own. */
export const isForeignBase = (base: string, preview: LanePreview): boolean =>
  base !== HEAD_BASE && preview.refs.find((ref) => ref.ref === base)?.inLineage === false;

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export const modelChoices = (overview: ModelsOverview): ModelChoice[] =>
  overview.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled)
      .map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
  );

const nextKey = (draft: Draft): number => Math.max(-1, ...draft.slots.map((slot) => slot.key)) + 1;

export const addSlot = (draft: Draft): Draft =>
  draft.slots.length >= LANE_LIMITS.fanout
    ? draft
    : { ...draft, slots: [...draft.slots, { key: nextKey(draft), model: null }] };

export const removeSlot = (draft: Draft, key: number): Draft =>
  draft.slots.length <= 1 ? draft : { ...draft, slots: draft.slots.filter((slot) => slot.key !== key) };

export const setModel = (draft: Draft, key: number, model: ModelPick | null): Draft => ({
  ...draft,
  slots: draft.slots.map((slot) => (slot.key === key ? { ...slot, model } : slot)),
});

export const withBase = (draft: Draft, base: string): Draft => ({ ...draft, base });

export function createParams(draft: Draft, projectRoot: string) {
  return {
    projectRoot,
    title: draft.title.trim(),
    description: draft.text,
    ...(draft.branch === "" ? {} : { branch: draft.branch }),
    ...(draft.base === HEAD_BASE ? {} : { baseRef: draft.base }),
    models: draft.slots.map((slot) => slot.model),
    ...(draft.issue === null ? {} : { issue: draft.issue }),
  };
}
