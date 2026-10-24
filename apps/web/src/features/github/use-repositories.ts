import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { githubFailure } from "./github-errors.ts";

export interface Repository {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

export type RepositoriesState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly key: MessageKey }
  | { readonly kind: "ready"; readonly repositories: readonly Repository[] };

/** A typed query waits this long for the next key before it asks GitHub. */
const TYPING_MS = 250;

/** `github.repositories` for a query: the first read at once, later ones after a pause in typing. */
export function useRepositories(query: string): RepositoriesState {
  const [state, setState] = useState<RepositoriesState>({ kind: "loading" });
  const first = useRef(true);
  useEffect(() => {
    let current = true;
    const ask = () =>
      getRuntime()
        .rpc.call("github.repositories", query.trim() === "" ? {} : { query: query.trim() })
        .then(
          ({ repositories }) => {
            if (current) setState({ kind: "ready", repositories });
          },
          (failure: unknown) => {
            if (current) setState({ kind: "failed", key: githubFailure(failure, true) });
          },
        );
    if (first.current) {
      first.current = false;
      void ask();
      return () => {
        current = false;
      };
    }
    const timer = setTimeout(() => void ask(), TYPING_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  return state;
}
