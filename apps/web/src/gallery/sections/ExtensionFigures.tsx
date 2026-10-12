import { AnsiText, CustomPanel, InputRequestCard, StatusBar, Widgets } from "@pap/ui/extensions";
import { EXT } from "../fixtures.ts";
import { GalleryItem } from "../GalleryItem.tsx";

const FRAME = { sourceLabel: EXT.source, detailsLabel: EXT.details, answered: false } as const;

/** What an extension draws on: its questions, status bar, widgets and custom panel. */
export function ExtensionFigures() {
  return (
    <>
      <GalleryItem name="InputRequestCard" column>
        <InputRequestCard
          {...FRAME}
          kind="select"
          title={EXT.selectTitle}
          message={EXT.message}
          timeoutLine={EXT.timeout}
          options={EXT.options}
          cancelLabel={EXT.cancel}
          onSelect={() => {}}
          onCancel={() => {}}
        />
        <InputRequestCard
          {...FRAME}
          kind="confirm"
          title={EXT.confirmTitle}
          yesLabel={EXT.yes}
          noLabel={EXT.no}
          onConfirm={() => {}}
        />
        <InputRequestCard
          {...FRAME}
          kind="text"
          title={EXT.textTitle}
          initialValue={EXT.textValue}
          submitLabel={EXT.submit}
          cancelLabel={EXT.cancel}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      </GalleryItem>
      <GalleryItem name="StatusBar" column>
        <StatusBar
          cells={EXT.cells}
          busy={false}
          label={EXT.statusLabel}
          sourceLabel={EXT.source}
          onCommand={() => {}}
        />
      </GalleryItem>
      <GalleryItem name="Widgets" column>
        <Widgets widgets={EXT.widgets} placement="aboveEditor" />
      </GalleryItem>
      <GalleryItem name="AnsiText">
        <AnsiText text={EXT.ansi} />
      </GalleryItem>
      <GalleryItem name="CustomPanel" column>
        <CustomPanel
          panelId="gallery"
          lines={EXT.panelLines}
          waitingLabel={EXT.panelWaiting}
          error={null}
          reachHint
          labels={EXT.panel}
          shouldTakeFocus={() => false}
          onKeyData={() => {}}
          onText={() => {}}
          onLeave={() => {}}
        />
      </GalleryItem>
    </>
  );
}
