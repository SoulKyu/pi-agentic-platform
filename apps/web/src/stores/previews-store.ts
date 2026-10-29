import { boxKey, PreviewsEvent, type BoxRef, type PreviewView } from "@pap/contracts";
import { create } from "zustand";

/** `<box key>/<service name>`: the key of a service here, of a preview item (`preview:` aside) and of an armed pane. */
export const previewKey = (box: BoxRef, name: string): string => `${boxKey(box)}/${name}`;

interface PreviewsState {
  /** The caller's own services by `previewKey`, as the `previews` stream last said. */
  readonly services: ReadonlyMap<string, PreviewView>;
  /** True once the stream gave its first snapshot: until then a missing service means nothing. */
  readonly ready: boolean;
  /** Panes the owner's own click opened (UX2-R77): only these mint a lease when they mount. Cleared when the pane unmounts. */
  readonly armed: ReadonlySet<string>;
  /** An OPEN PREVIEW clicked on a page: the shell takes it (PF-4: features never import the workspace). */
  readonly requested: { readonly box: string; readonly name: string } | null;
  apply(event: unknown): void;
  request(target: { readonly box: string; readonly name: string }): void;
  clearRequest(): void;
  arm(key: string): void;
  disarm(key: string): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The `previews` stream: a snapshot replaces, a service event upserts, a removal deletes. Garbage is skipped, never fatal. */
export const usePreviewsStore = create<PreviewsState>()((set) => ({
  services: new Map(),
  ready: false,
  armed: new Set(),
  requested: null,
  request: (target) => set({ requested: { box: target.box, name: target.name } }),
  clearRequest: () => set({ requested: null }),
  apply: (raw) => {
    const parsed = PreviewsEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    set((state) => {
      switch (event.type) {
        case "snapshot":
          return {
            ready: true,
            services: new Map(event.services.map((one) => [previewKey(one.box, one.name), one])),
          };
        case "service":
          return {
            services: new Map(state.services).set(
              previewKey(event.service.box, event.service.name),
              event.service,
            ),
          };
        case "removed": {
          const services = new Map(state.services);
          services.delete(previewKey(event.box, event.name));
          return { services };
        }
      }
    });
  },
  arm: (key) => set((state) => (state.armed.has(key) ? state : { armed: new Set(state.armed).add(key) })),
  disarm: (key) =>
    set((state) => {
      if (!state.armed.has(key)) return state;
      const armed = new Set(state.armed);
      armed.delete(key);
      return { armed };
    }),
  reset: () => set({ services: new Map(), ready: false, armed: new Set(), requested: null }),
}));
