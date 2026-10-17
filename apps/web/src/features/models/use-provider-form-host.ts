import { useState } from "react";

type Target = { readonly id?: string };

/**
 * Which provider form is open (null: none), whether its draft is unsaved, a switch waiting for the owner's answer,
 * and whether the file is known to hold comments.
 */
export function useProviderFormHost() {
  const [form, setForm] = useState<Target | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<Target | null>(null);
  const [commented, setCommented] = useState(false);
  // A provider whose entry is gone but whose stored key may remain (MPR-C5): kept here, so it outlives the form.
  const [orphanKey, setOrphanKey] = useState<string | null>(null);
  const open = (target: Target) => {
    if (dirty && form !== null && form.id !== target.id) setPending(target);
    else setForm(target);
  };
  return {
    form,
    dirty,
    setDirty,
    pending,
    commented,
    setCommented,
    orphanKey,
    setOrphanKey,
    openAdd: () => open({}),
    openEdit: (id: string) => open({ id }),
    close: () => {
      setForm(null);
      setPending(null);
    },
    discard: () => {
      setDirty(false);
      setForm(pending);
      setPending(null);
    },
    keep: () => setPending(null),
  };
}
export type ProviderFormHost = ReturnType<typeof useProviderFormHost>;
