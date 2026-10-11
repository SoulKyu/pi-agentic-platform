import { Button, toast } from "@pap/ui";
import { Dialog, Menu, type DialogVariant } from "@pap/ui/overlays";
import { useState } from "react";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { GalleryItem } from "../GalleryItem.tsx";

const DIALOGS: ReadonlyArray<{ readonly variant: DialogVariant; readonly label: MessageKey }> = [
  { variant: "center", label: "gallery.open.center" },
  { variant: "sheet", label: "gallery.open.sheet" },
  { variant: "drawer-left", label: "gallery.open.drawerLeft" },
  { variant: "drawer-right", label: "gallery.open.drawerRight" },
  { variant: "palette", label: "gallery.open.palette" },
];

/** Overlays open from buttons (M3R123) and exist only while open: a closed gallery holds no dialog and no menu. */
export function OverlayFigures() {
  const t = useT();
  const [dialog, setDialog] = useState<DialogVariant | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
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
      <GalleryItem name="Menu">
        {menuOpen ? (
          <Menu
            defaultOpen
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
