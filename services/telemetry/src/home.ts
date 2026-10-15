/** The public page at `/`: what Dispatch is and where to get it. No scripts, no tracking. */
export function renderHome(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch</title><meta name="description" content="Dispatch is an open-source app that runs and manages AI coding agents on your own computer.">
<style>
:root{--bg:#fafaf9;--fg:#1c1c1e;--mute:#6b6b70;--line:#e5e5e3;--accent:#1f8f4e}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececee;--mute:#8b8b92;--line:#26262b;--accent:#3ecf72}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,system-ui,sans-serif}
main{max-width:620px;margin:0 auto;padding:18vh 16px 48px}h1{font-size:34px;margin:0 0 12px;letter-spacing:-.02em}
p{color:var(--mute);margin:0 0 24px}a{color:var(--accent);font-weight:600;text-decoration:none}a:hover{text-decoration:underline}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--mute)}
</style></head><body><main>
<h1>Dispatch</h1>
<p>Dispatch is an open-source app that runs and manages AI coding agents, such as Claude Code, Codex and OpenCode, on your own computer. You use it from a browser on your desktop or your phone.</p>
<a href="https://github.com/davidwebber10/dispatch">Get Dispatch on GitHub →</a>
<footer>Dispatch · open source</footer>
</main></body></html>`;
}
