// Runs as a blocking classic script before the first paint. vite/appearance-boot.ts emits it under /assets/ and links
// it first in <head>: the CSP has no 'unsafe-inline' for scripts (R74). It replays what apply.ts last wrote to
// localStorage "pap.appearance.boot" and ignores anything unexpected: only known attributes with plain word values,
// only the custom properties the app writes (apply.ts BOOT_VAR_NAMES) with hex or px values. ES2019 (optional catch
// binding), no imports; any failure leaves the defaults of tokens.css.
(function () {
  try {
    // The default density, so a first visit paints what the settings later confirm (no 14 to 15 px jump).
    document.documentElement.setAttribute("data-density", "mixed");
    var raw = window.localStorage.getItem("pap.appearance.boot");
    if (!raw) return;
    var cache = JSON.parse(raw);
    if (!cache || cache.v !== 1) return;
    var root = document.documentElement;
    var names = [
      "density",
      "font-ui",
      "font-mono",
      "labels",
      "grid",
      "rail",
      "motion",
      "chat-width",
      "prose",
      "tool-detail",
      "avatar",
    ];
    // apply.ts BOOT_VAR_NAMES without the leading "--" (boot-script.test.ts proves the two lists are equal).
    var allowed =
      "bg bg-side surface surface-2 border border-strong control-border text text-muted text-dim grid focus-ring agent agent-fill agent-ink you you-fill you-ink you-tint you-line you-text attn attn-fill attn-ink attn-tint attn-line attn-title ok err diff-add diff-del size-ui size-chat size-code".split(
        " ",
      );
    var word = /^[a-z0-9-]{1,32}$/;
    var varValue = /^(#[0-9a-f]{6}([0-9a-f]{2})?|\d{1,2}(\.\d{1,2})?px)$/i;
    var setVars = function (vars) {
      if (!vars || typeof vars !== "object") return;
      Object.keys(vars).forEach(function (name) {
        var value = vars[name];
        var known = name.slice(0, 2) === "--" && allowed.indexOf(name.slice(2)) !== -1;
        if (known && typeof value === "string" && varValue.test(value)) root.style.setProperty(name, value);
      });
    };
    var attrs = cache.attrs && typeof cache.attrs === "object" ? cache.attrs : {};
    names.forEach(function (name) {
      var value = attrs[name];
      if (typeof value === "string" && word.test(value)) root.setAttribute("data-" + name, value);
    });
    setVars(cache.vars);
    var light =
      cache.mode === "day" ||
      (cache.mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    var side = light ? cache.light : cache.dark;
    if (side && (side.theme === "night" || side.theme === "day" || side.theme === "hc")) {
      root.setAttribute("data-theme", side.theme);
      setVars(side.vars);
    }
  } catch {
    // The defaults of tokens.css apply; the app rewrites the cache once it starts.
    if (typeof console !== "undefined") console.warn("pap: appearance_boot_failed");
  }
})();
