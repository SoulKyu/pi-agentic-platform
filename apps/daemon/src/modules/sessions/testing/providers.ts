import type { AvailableModels } from "@pap/contracts";

/** A providers gate that shares everything: the sessions tests that are not about sharing. */
export const sharesAll = {
  sessionModels: async <T>(_userId: string, data: T): Promise<T> => data,
  available: async (): Promise<AvailableModels> => ({
    models: [],
    providers: [],
    origin: "scope",
    truncated: false,
  }),
};
