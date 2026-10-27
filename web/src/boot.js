// boot.js — runs before any bundle (a classic, blocking <script> in index.html's <head>), so the first paint is already
// in the right theme. It used to be inline in index.html; it is a file now so the app's Content-Security-Policy can say
// `script-src 'self'` with no inline exception (security review 2026-10-26, M3). vite.config.ts (bootScript) emits it as
// assets/boot-<hash>.js in a build — cached like every other asset — and inlines it in `vite` dev. Plain ES5, no imports.
// Before any bundle: the theme shown last (pref "theme", the theme store's mirror) so the first paint is already
// right — the built-ins through index.html's generated <style> rules; any other theme from the boot variables the runtime
// cached for it (pref "theme-boot" = {id, variant, vars}, ui/themes.ts).
// An iPhone/iPad Home Screen app: tokens.css "iOS Home Screen app" + core/device.ts keyboardInset() keep the page
// screen-tall and its text clear of the system's fade under the clock (iOS 26/27).
try {
  if (navigator.standalone === true) document.documentElement.setAttribute("data-ios-pwa", "");
} catch (e) {}
try {
  var t = localStorage.getItem("tinhat.pref.theme");
  var de = document.documentElement;
  if (t === "goose") de.setAttribute("data-theme", "goose");
  else if (t && t !== "oled") {
    var b = JSON.parse(localStorage.getItem("tinhat.pref.theme-boot") || "null");
    if (b && b.id === t && b.vars) {
      for (var k in b.vars) if (k.indexOf("--th-") === 0) de.style.setProperty(k, b.vars[k]);
      de.setAttribute("data-theme", t);
      if (b.variant === "light") de.style.colorScheme = "light";
    }
  }
} catch (e) {}
