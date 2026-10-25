import {
  Avatar,
  Badge,
  Banner,
  Button,
  Chip,
  CodeText,
  DeferredFallback,
  EmptyState,
  Heading,
  Icon,
  IconAccount,
  IconButton,
  IconCopy,
  IconSearch,
  InlineError,
  Kbd,
  Meter,
  OpenTab,
  ProgressBar,
  Spinner,
  Tooltip,
} from "@pap/ui";
import { useId, useState } from "react";
import { useT } from "../../i18n/index.ts";
import {
  AVATAR_PRESENCE,
  AVATAR_STYLES,
  BANNER_KINDS,
  BUTTON_SCALES,
  BUTTON_KINDS,
  CHIP_KINDS,
  SAMPLE,
} from "../fixtures.ts";
import { GalleryItem } from "../GalleryItem.tsx";

function Tabs() {
  const t = useT();
  const prefix = useId();
  const [selected, setSelected] = useState<"first" | "second" | "third">("first");
  const tabs = [
    { id: "first", status: null },
    { id: "second", status: "running" },
    { id: "third", status: "waiting" },
  ] as const;
  return (
    <div role="tablist" aria-label={t("gallery.section.primitives")} className="flex flex-wrap gap-s1">
      {tabs.map((tab) => (
        <OpenTab
          key={tab.id}
          tabId={`${prefix}-${tab.id}`}
          title={SAMPLE.tabTitle}
          active={selected === tab.id}
          status={tab.status}
          closeLabel={t("gallery.tab.close")}
          onSelect={() => setSelected(tab.id)}
          onClose={() => setSelected("first")}
        />
      ))}
    </div>
  );
}

/** The presentational primitives and the buttons: states side by side, nothing stateful but the tabs. */
export function DisplayFigures() {
  return (
    <>
      <GalleryItem name="Button">
        {BUTTON_KINDS.flatMap((variant) =>
          BUTTON_SCALES.map((size) => (
            <Button key={`${variant}:${size}`} variant={variant} size={size}>
              {SAMPLE.button}
            </Button>
          )),
        )}
        <Button disabled>{SAMPLE.disabled}</Button>
      </GalleryItem>
      <GalleryItem name="Spinner">
        <Spinner />
      </GalleryItem>
      <GalleryItem name="Icon">
        <Icon icon={IconSearch} size={14} />
        <Icon icon={IconSearch} />
        <Icon icon={IconSearch} size={20} />
        <Icon icon={IconAccount} size={28} label={SAMPLE.agentName} />
      </GalleryItem>
      <GalleryItem name="IconButton">
        <IconButton icon={IconSearch} label={SAMPLE.tooltip} variant="ghost" />
        <IconButton
          icon={IconCopy}
          label={SAMPLE.button}
          variant="secondary"
          badge={{ count: 3, label: SAMPLE.badge }}
        />
        <IconButton icon={IconSearch} label={SAMPLE.tooltip} size="sm" />
      </GalleryItem>
      <GalleryItem name="Tooltip">
        <Tooltip label={SAMPLE.tooltip} shortcut={SAMPLE.tooltipShortcut} shortcutJoiner="+">
          <Button variant="secondary">{SAMPLE.button}</Button>
        </Tooltip>
      </GalleryItem>
      <GalleryItem name="Kbd">
        <Kbd keys={SAMPLE.tooltipShortcut} joiner="+" />
      </GalleryItem>
      <GalleryItem name="Chip">
        {CHIP_KINDS.map((tone) => (
          <Chip key={tone} tone={tone} label={tone} dot={tone === "run"} />
        ))}
      </GalleryItem>
      <GalleryItem name="Badge">
        <Badge count={3} label={SAMPLE.badge} />
        <Badge count={120} label={SAMPLE.badge} />
      </GalleryItem>
      <GalleryItem name="Avatar">
        {AVATAR_STYLES.map((avatarStyle, index) => (
          <Avatar
            key={avatarStyle}
            initials="AG"
            name={SAMPLE.agentName}
            avatarStyle={avatarStyle}
            presence={AVATAR_PRESENCE[index]}
            badge={index === 0 ? { count: 2, label: SAMPLE.badge } : undefined}
          />
        ))}
      </GalleryItem>
      <GalleryItem name="Meter" column>
        <Meter label={SAMPLE.tokens} value={48} max={200} kind="tokens" valueText={SAMPLE.tokensValue} />
        <Meter label={SAMPLE.cost} value={1.24} max={5} kind="cost" valueText={SAMPLE.costValue} />
      </GalleryItem>
      <GalleryItem name="ProgressBar" column>
        <ProgressBar label={SAMPLE.progress} value={40} />
        <ProgressBar label={SAMPLE.progress} />
      </GalleryItem>
      <GalleryItem name="Banner" column>
        {BANNER_KINDS.map((tone) => (
          <Banner key={tone} tone={tone} title={SAMPLE.bannerTitle}>
            {SAMPLE.bannerBody}
          </Banner>
        ))}
      </GalleryItem>
      <GalleryItem name="EmptyState" column>
        <EmptyState
          title={SAMPLE.emptyTitle}
          purpose={SAMPLE.emptyPurpose}
          action={<Button variant="primary">{SAMPLE.emptyAction}</Button>}
        />
      </GalleryItem>
      <GalleryItem name="InlineError" column>
        <InlineError announce="background">{SAMPLE.bannerTitle}</InlineError>
        <InlineError tone="attn" announce="background">
          {SAMPLE.bannerBody}
        </InlineError>
      </GalleryItem>
      <GalleryItem name="CodeText" column>
        <p className="text-ui text-muted">
          <CodeText text={SAMPLE.codeText} />
        </p>
      </GalleryItem>
      <GalleryItem name="DeferredFallback" column>
        <DeferredFallback>
          <p className="text-ui text-muted">{SAMPLE.progress}</p>
        </DeferredFallback>
      </GalleryItem>
      <GalleryItem name="Heading" column>
        <Heading level={2} variant="section">
          {SAMPLE.emptyTitle}
        </Heading>
        <Heading level={3} variant="group">
          {SAMPLE.emptyTitle}
        </Heading>
        <Heading level={4} variant="card">
          {SAMPLE.emptyTitle}
        </Heading>
      </GalleryItem>
      <GalleryItem name="OpenTab" column>
        <Tabs />
      </GalleryItem>
    </>
  );
}
