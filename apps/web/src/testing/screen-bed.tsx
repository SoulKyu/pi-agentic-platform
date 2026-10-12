import type { ReactElement } from "react";
import { afterEach, beforeEach } from "vitest";
import { SessionScreen } from "../features/sessions/SessionScreen.tsx";
import type { Runtime } from "../runtime/index.ts";
import { useSessionStore } from "../stores/session-store.ts";
import { mount, settle, type Mounted } from "./dom.ts";
import { fakeRuntime } from "./runtime-bed.ts";
import { sessionSnapshot } from "./session-snapshot.ts";

/**
 * Mounts `SessionScreen` for session `sess-1` on a fake runtime. The test file keeps its own `vi.mock` of `getRuntime`
 * (it must be hoisted there) and hands the `current` holder it reads from; `screenBed` registers the hooks (it is not a React hook).
 */
export function screenBed(current: { runtime: Runtime | undefined }) {
  const state = { bed: fakeRuntime(), page: null as Mounted | null };
  beforeEach(() => {
    localStorage.clear();
    state.bed = fakeRuntime();
    current.runtime = state.bed.runtime;
    useSessionStore.setState({ views: {} });
  });
  afterEach(async () => {
    await state.page?.unmount();
    state.page = null;
  });
  const emit = async (event: unknown) => {
    state.bed.emit(event);
    await settle();
  };
  /** Unmounts the screen and mounts it again on the same store; the new feed has a new subscription, so no snapshot arrives. */
  const remount = async (element?: ReactElement) => {
    await state.page?.unmount();
    state.page = await mount(element ?? <SessionScreen sessionId="sess-1" />);
    await settle();
    return state.page.container;
  };
  const show = async (viewPatch: Record<string, unknown>) => {
    const container = await remount();
    await emit(sessionSnapshot(viewPatch));
    return container;
  };
  return {
    get bed() {
      return state.bed;
    },
    emit,
    remount,
    show,
    methods: () =>
      state.bed.calls.map((call) => call.method).filter((method) => method !== "subscribe.session"),
  };
}
