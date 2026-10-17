import { Button, Chip, Collapsible, Switch } from "@pap/ui";
import { useState } from "react";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import type { ProviderRow } from "./availability.vm.ts";

/** Models drawn at first; a provider with hundreds (a gateway) shows the rest on request (as `EnabledSwitches`). */
const MODELS_SHOWN = 100;

interface RowHandlers {
  onProvider(provider: string, on: boolean): void;
  onModel(provider: string, modelId: string, on: boolean): void;
}

function ModelSwitches({
  row,
  disabled,
  pending,
  handlers,
}: {
  readonly row: ProviderRow;
  readonly disabled: boolean;
  readonly pending: ReadonlySet<string>;
  readonly handlers: RowHandlers;
}) {
  const t = useT();
  const [shown, setShown] = useState(MODELS_SHOWN);
  return (
    <div className="flex flex-col gap-s2 pl-s4">
      {!row.connected ? <p className="text-ui text-muted">{t("settingsAvailability.notOffered")}</p> : null}
      <ul className="flex flex-col gap-s1">
        {row.models.slice(0, shown).map((model, at) => (
          <li key={`${at}:${model.id}`} data-model={model.id}>
            <Switch
              label={model.label}
              checked={model.enabled}
              disabled={disabled || pending.has(`m:${row.id}/${model.id}`)}
              onChange={(on) => handlers.onModel(row.id, model.id, on)}
            />
          </li>
        ))}
      </ul>
      {row.models.length > shown ? (
        <div>
          <Button onClick={() => setShown((count) => count + MODELS_SHOWN)}>
            {t("settingsAvailability.models.more", { count: row.models.length - shown })}
          </Button>
        </div>
      ) : null}
      {row.modelsTruncated ? (
        <p className="text-ui text-muted">{t("settingsAvailability.models.truncated")}</p>
      ) : null}
    </div>
  );
}

function ProviderItem({
  row,
  disabled,
  pending,
  stack,
  handlers,
}: {
  readonly row: ProviderRow;
  readonly disabled: boolean;
  readonly pending: ReadonlySet<string>;
  readonly stack: boolean;
  readonly handlers: RowHandlers;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const allOn = row.total > 0 && row.enabled === row.total;
  return (
    <li data-provider-row={row.id} className="flex flex-col gap-s1">
      <div className={stack ? "flex flex-col gap-s1" : "flex items-center gap-s3"}>
        <div className="min-w-0 flex-1">
          <Switch
            label={row.name}
            checked={allOn}
            disabled={disabled || row.total === 0 || pending.has(`p:${row.id}`)}
            onChange={(on) => handlers.onProvider(row.id, on)}
            {...(!allOn && row.enabled > 0
              ? { hint: t("settingsAvailability.partial", { on: row.enabled, total: row.total }) }
              : {})}
          />
        </div>
        <div className="flex shrink-0 items-center gap-s2">
          {row.connected ? (
            <Chip tone="ok" label={t("settingsAvailability.chip.connected")} />
          ) : (
            <Chip tone="mut" label={t("settingsAvailability.chip.notConnected")} />
          )}
          <span className="text-ui text-muted">
            {row.offered === null
              ? plural(locale, "settingsAvailability.count.total", row.total)
              : t("settingsAvailability.count", { offered: row.offered, total: row.total })}
          </span>
        </div>
      </div>
      {row.total > 0 ? (
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          trigger={
            <span className="text-ui text-muted underline">
              {open
                ? t("settingsAvailability.collapse", { provider: row.name })
                : t("settingsAvailability.expand", { provider: row.name })}
            </span>
          }
        >
          <ModelSwitches row={row} disabled={disabled} pending={pending} handlers={handlers} />
        </Collapsible>
      ) : null}
    </li>
  );
}

/**
 * One row per provider: its switch, whether it is connected, `offered/total`, and its models behind a disclosure. A
 * model of a provider that is not connected can be switched on: it is offered once the provider is (M7R54).
 */
export function ProviderRows({
  rows,
  disabled,
  pending,
  stack,
  handlers,
}: {
  readonly rows: readonly ProviderRow[];
  readonly disabled: boolean;
  readonly pending: ReadonlySet<string>;
  readonly stack: boolean;
  readonly handlers: RowHandlers;
}) {
  const t = useT();
  return (
    <ul aria-label={t("settingsAvailability.providers")} className="flex flex-col gap-s3">
      {rows.map((row, at) => (
        <ProviderItem
          key={`${at}:${row.id}`}
          row={row}
          disabled={disabled}
          pending={pending}
          stack={stack}
          handlers={handlers}
        />
      ))}
    </ul>
  );
}
