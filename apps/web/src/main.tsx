import "./csp-safe-zod.ts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAppearance } from "./features/appearance/index.ts";
import { startKeybindings } from "./features/commands/index.ts";
import { pickLocale, setLocale, useT } from "./i18n/index.ts";
import { router } from "./routes/router.tsx";
import "./styles.css";

// A plain t() would keep the language the page started in (R128).
function LocalizedToaster() {
  const t = useT();
  return <Toaster closeLabel={t("ui.dismiss")} />;
}

const locale = pickLocale(navigator.languages, localStorage.getItem("pap.locale"));
setLocale(locale);
document.documentElement.lang = locale;
startAppearance();
startKeybindings();
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
      <LocalizedToaster />
    </TooltipProvider>
  </StrictMode>,
);
