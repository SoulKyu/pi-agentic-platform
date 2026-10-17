import { Button, toast } from "@pap/ui";
import { Dialog, Menu, type DialogVariant } from "@pap/ui/overlays";
import { useState } from "react";
import { ModelPickerField } from "../../features/models/picker/index.ts";
import type { AvailableState } from "../../features/models/picker/use-available-models.ts";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { GalleryItem } from "../GalleryItem.tsx";

const DIALOGS: ReadonlyArray<{ readonly variant: DialogVariant; readonly label: MessageKey }> = [
  { variant: "center", label: "gallery.open.center" },
  { variant: "sheet", label: "gallery.open.sheet" },
  { variant: "drawer-left", label: "gallery.open.drawerLeft" },
  { variant: "drawer-right", label: "gallery.open.drawerRight" },
  { variant: "palette", label: "gallery.open.palette" },
];

// 2000 models in 20 providers, the size at which the list must scroll inside a modal dialog (MPR27, controller step C2).
const PICKER_FIXTURE: AvailableState = {
  status: "ready",
  models: Array.from({ length: 2000 }, (_, index) => ({
    provider: `provider-${String(Math.floor(index / 100)).padStart(2, "0")}`,
    id: `model-${String(index).padStart(4, "0")}`,
    name: `Model ${index}`,
    reasoning: index % 2 === 0,
  })),
  labels: new Map(),
  origin: "signed-in",
  truncated: false,
};

/** Overlays open from buttons (M3R123) and exist only while open: a closed gallery holds no dialog and no menu. */
export function OverlayFigures() {
  const t = useT();
  const [dialog, setDialog] = useState<DialogVariant | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<{ provider: string; modelId: string } | null>(null);
  return (
    <>
      <p data-gallery-note="overlays" className="text-ui text-muted md:col-span-2">
        {t("gallery.overlayNote")}
      </p>
      <GalleryItem name="Dialog">
        {DIALOGS.map(({ variant, label }) => (
          <Button key={variant} variant="secondary" onClick={() => setDialog(variant)}>
            {t(label)}
          </Button>
        ))}
        {dialog === null ? null : (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDialog(null);
            }}
            variant={dialog}
            title={t("gallery.dialog.title")}
            description={t("gallery.dialog.body")}
            closeLabel={t("ui.close")}
            footer={
              <Button variant="primary" onClick={() => setDialog(null)}>
                {t("gallery.dialog.confirm")}
              </Button>
            }
          >
            <p className="p-s3 text-ui text-muted">{t("gallery.dialog.body")}</p>
          </Dialog>
        )}
      </GalleryItem>
      <GalleryItem name="Model picker in a dialog, 2000 models">
        <div data-testid="gallery-picker-in-dialog">
          <Button variant="secondary" onClick={() => setPickerOpen(true)}>
            {t("gallery.open.picker")}
          </Button>
          {pickerOpen ? (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setPickerOpen(false);
              }}
              title={t("gallery.picker.title")}
              closeLabel={t("ui.close")}
            >
              <div className="p-s3">
                <ModelPickerField
                  label={t("gallery.picker.label")}
                  value={picked}
                  cwd={null}
                  available={PICKER_FIXTURE}
                  onChange={setPicked}
                />
              </div>
            </Dialog>
          ) : null}
        </div>
      </GalleryItem>
      <GalleryItem name="Menu">
        {menuOpen ? (
          <Menu
            defaultOpen
            onOpenChange={(open) => setMenuOpen(open)}
            label={t("gallery.menu.label")}
            closeLabel={t("ui.close")}
            trigger={<Button variant="secondary">{t("gallery.open.menu")}</Button>}
            items={[
              { id: "first", label: t("gallery.menu.first"), onSelect: () => setMenuOpen(false) },
              { id: "second", label: t("gallery.menu.second"), onSelect: () => setMenuOpen(false) },
              {
                id: "danger",
                label: t("gallery.menu.danger"),
                tone: "danger",
                onSelect: () => setMenuOpen(false),
              },
            ]}
          />
        ) : (
          <Button variant="secondary" onClick={() => setMenuOpen(true)}>
            {t("gallery.open.menu")}
          </Button>
        )}
      </GalleryItem>
      <GalleryItem name="toast">
        <Button
          variant="secondary"
          onClick={() =>
            toast({
              message: t("gallery.toast.message"),
              action: {
                label: t("gallery.toast.undo"),
                altText: t("gallery.toast.undoAlt"),
                run: () => toast({ message: t("gallery.toast.undone") }),
              },
            })
          }
        >
          {t("gallery.open.toast")}
        </Button>
      </GalleryItem>
    </>
  );
}
