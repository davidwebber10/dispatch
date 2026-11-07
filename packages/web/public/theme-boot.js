// Paints the saved theme before the app's scripts load, so a launch in a light theme never flashes
// dark (and the reverse). The app saves the payload (src/themes/apply.ts, BOOT_KEY) each time it
// applies a theme. A classic script, not inline: the page's Content-Security-Policy is script-src 'self'.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('dispatch:themeBoot') || 'null');
    if (!p) return;
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var t = p.fixed || (dark ? p.dark : p.light);
    if (!t || !t.vars) return;
    var r = document.documentElement;
    for (var k in t.vars) r.style.setProperty(k, t.vars[k]);
    r.style.colorScheme = t.scheme;
    r.setAttribute('data-theme', t.id);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t.color);
  } catch (e) { /* no storage: theme.css defaults (Dispatch Dark) */ }
})();
