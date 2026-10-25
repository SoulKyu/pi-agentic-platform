/** A providers gate that shares everything with everyone: the tests that are not about sharing. */
export const sharesAllProviders = {
  filter: async <T>(_userId: string, items: readonly T[]): Promise<T[]> => [...items],
  reset: () => {},
};
