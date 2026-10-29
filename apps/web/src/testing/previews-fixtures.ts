import type { BoxRef, PreviewView } from "@pap/contracts";

export const PROJECT_ID = "0b8f6f6e-1111-4222-8333-444455556666";
export const PROJECT_BOX: BoxRef = { kind: "project", id: PROJECT_ID };
export const AGENT_BOX: BoxRef = { kind: "agent", id: "atlas-1a2b" };

/** A preview service of a box as the `previews` stream describes it. */
export const previewView = (patch: Partial<PreviewView> = {}): PreviewView => ({
  id: "a".repeat(32),
  name: "web",
  port: 8000,
  state: "running",
  reason: null,
  startedAt: 1,
  network: false,
  box: PROJECT_BOX,
  ...patch,
});

/** happy-dom would fetch an iframe's `src`: a test never reaches the network, so the frame stays unloaded. */
export function keepFramesUnloaded(): void {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
}
