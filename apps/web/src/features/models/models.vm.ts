import { LoginStreamEvent, type LoginPrompt, type ModelsOverview, type ProviderView } from "@pap/contracts";
import { t } from "../../i18n/index.ts";
import { failureCode, failureText } from "./failure.ts";

export type SignInState = "configured" | "notConfigured" | "unknown";

/** `unknown`: pap could not read the sign-in files (MC26); never guessed from the rest of the row. */
export function signInState(provider: ProviderView): SignInState {
  if (provider.auth.status === "unknown") return "unknown";
  return provider.auth.configured ? "configured" : "notConfigured";
}

export const envIsSet = (provider: ProviderView): boolean =>
  provider.auth.env.some((variable) => variable.set);

export interface SwitchState {
  /** On only while every model is on (M7R68). */
  readonly on: boolean;
  readonly enabled: number;
  readonly total: number;
}

export function providerSwitch(models: ProviderView["models"]): SwitchState {
  const enabled = models.filter((model) => model.enabled).length;
  return { on: models.length > 0 && enabled === models.length, enabled, total: models.length };
}

/** The settings file that decides when a project scope is in force: every switch and star is read-only then. */
export const readOnlyPath = (
  enabled: Pick<ModelsOverview["enabled"], "scope" | "settingsPath">,
): string | null => (enabled.scope === "project" ? enabled.settingsPath : null);

export type WriteFailureKind = "lastModel" | "projectScope" | "capacity" | "unknownOutcome" | "other";

/** Which fixed text a failed write gets. `conflict` of `models.setEnabled` is the last-model refusal (M7R55). */
export function writeFailureKind(failure: unknown): WriteFailureKind {
  switch (failureCode(failure)) {
    case "conflict":
      return "lastModel";
    case "project_scope":
      return "projectScope";
    case "capacity":
      return "capacity";
    case "timeout":
    case "connection_lost":
      return "unknownOutcome";
    default:
      return "other";
  }
}

/** What a failed write says: a fixed text per refusal that has one, else the code's own text. */
export function writeFailureText(failure: unknown, settingsPath: string | null): string {
  switch (writeFailureKind(failure)) {
    case "lastModel":
      return t("settingsModels.err.lastModel");
    case "projectScope":
      return settingsPath === null
        ? failureText(failure)
        : t("settingsModels.err.projectScope", { path: settingsPath });
    case "capacity":
      return t("settingsModels.err.capacity");
    case "unknownOutcome":
      return t("settingsModels.err.unknownOutcome");
    case "other":
      return failureText(failure);
  }
}

/** The most notes (progress and info lines) a flow keeps on screen. */
export const NOTES_MAX = 8;

export interface FlowView {
  readonly link: { readonly url: string; readonly instructions?: string | undefined } | null;
  readonly device: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresInSeconds?: number | undefined;
  } | null;
  readonly notes: readonly string[];
  readonly links: ReadonlyArray<{ readonly url: string; readonly label?: string | undefined }>;
  readonly prompt: { readonly promptId: string; readonly prompt: LoginPrompt } | null;
  readonly done: { readonly ok: boolean; readonly code?: string | undefined } | null;
}

export const EMPTY_FLOW: FlowView = {
  link: null,
  device: null,
  notes: [],
  links: [],
  prompt: null,
  done: null,
};

const pushNote = (view: FlowView, message: string): readonly string[] =>
  [...view.notes, message].slice(-NOTES_MAX);

function applyOne(view: FlowView, event: Exclude<LoginStreamEvent, { kind: "snapshot" }>): FlowView {
  switch (event.kind) {
    case "auth_url":
      return { ...view, link: { url: event.url, instructions: event.instructions } };
    case "device_code":
      return {
        ...view,
        device: {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresInSeconds: event.expiresInSeconds,
        },
      };
    case "progress":
      return { ...view, notes: pushNote(view, event.message) };
    case "info":
      return {
        ...view,
        notes: pushNote(view, event.message),
        links: event.links ? event.links.map((link) => ({ url: link.url, label: link.label })) : view.links,
      };
    case "prompt":
      return { ...view, prompt: { promptId: event.promptId, prompt: event.prompt } };
    case "done":
      // Over: the sign-in link and the device code can no longer be used, so they leave the screen.
      return { ...view, link: null, device: null, prompt: null, done: { ok: event.ok, code: event.code } };
  }
}

/** Folds one `login` stream event (a snapshot replays its events in order). A malformed event changes nothing. */
export function applyLoginStreamEvent(view: FlowView, event: unknown): FlowView {
  const parsed = LoginStreamEvent.safeParse(event);
  if (!parsed.success) return view;
  const one = parsed.data;
  return one.kind === "snapshot" ? one.events.reduce(applyOne, view) : applyOne(view, one);
}

/** True when the events say the flow has ended. */
export const flowDone = (events: readonly LoginStreamEvent[]): boolean =>
  events.some((event) =>
    event.kind === "snapshot" ? event.events.some((inner) => inner.kind === "done") : event.kind === "done",
  );
