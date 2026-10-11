import "./csp-safe-zod.ts";
import { TooltipProvider } from "@pap/ui";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pickLocale, setLocale } from "./i18n/index.ts";
import { router } from "./routes/router.tsx";
import "./styles.css";

const locale = pickLocale(navigator.languages, localStorage.getItem("pap.locale"));
setLocale(locale);
document.documentElement.lang = locale;
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </StrictMode>,
);
