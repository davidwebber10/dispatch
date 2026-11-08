#!/usr/bin/env node
// Screenshots every Settings section of a running (isolated) Dispatch daemon, phone and desktop.
//
//   node shoot.mjs <baseUrl> <outDir> [only]
//
// Writes <outDir>/<section>-phone.png (390x844, isMobile, hasTouch) and <section>-desktop.png
// (1440x900), plus index-phone.png / index-desktop.png. `only` is a comma list of section keys.
// Each image holds the WHOLE section: the settings content scrolls inside a container, so the
// viewport grows until no container scrolls any more, then the shot is taken.
//
// Playwright is not a dependency of the repo. This script finds it in this order:
//   1. a normal `import('playwright')` (it resolves if you installed it somewhere on the path),
//   2. $PLAYWRIGHT_MODULE (a path to a playwright package folder),
//   3. the npx cache (~/.npm/_npx/*/node_modules/playwright), newest version first.
// It launches the bundled Chromium of that version, or the installed Google Chrome when that
// Chromium is not downloaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [base, outDir, onlyArg] = process.argv.slice(2);
if (!base || !outDir) { console.error('usage: shoot.mjs <baseUrl> <outDir> [section,section]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

/** Built-in sections (packages/web/src/components/settings/sections.tsx) plus the Coach plugin's, as a reference. */
const SECTIONS = [
  ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['dictation', 'Dictation'],
  ['agents', 'Agents'], ['accounts', 'Accounts'], ['usage', 'Usage limits'], ['integrations', 'Integrations'],
  ['secrets', 'Secrets'], ['tools', 'Tools'], ['devices', 'Devices & access'], ['servers', 'Servers'],
  ['plugins', 'Plugins'], ['skills', 'Skills'], ['about', 'About & updates'], ['coach', 'Coach'],
];
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const wanted = SECTIONS.filter(([k]) => !only || only.has(k));
const wantIndex = !only || only.has('index');

function semverDesc(a, b) {
  const pa = a.v.split(/[.-]/).map((x) => parseInt(x, 10) || 0); const pb = b.v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}
function candidates() {
  const out = [];
  if (process.env.PLAYWRIGHT_MODULE) out.push(process.env.PLAYWRIGHT_MODULE);
  const npx = path.join(os.homedir(), '.npm', '_npx');
  const found = [];
  try {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright');
      try { found.push({ p, v: JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version }); } catch { /* not there */ }
    }
  } catch { /* no npx cache */ }
  return [...out, ...found.sort(semverDesc).map((f) => f.p)];
}

async function launch() {
  const mods = [];
  try { mods.push(await import('playwright')); } catch { /* not resolvable */ }
  const req = createRequire(import.meta.url);
  for (const p of candidates()) { try { mods.push(req(p)); } catch { /* broken folder */ } }
  for (const m of mods) {
    const chromium = m.chromium ?? m.default?.chromium;
    if (!chromium) continue;
    try { return await chromium.launch(); } catch { /* its Chromium is not downloaded */ }
    try { return await chromium.launch({ channel: 'chrome' }); } catch { /* no Chrome either */ }
  }
  throw new Error('No usable Playwright found. Install one (npx -y playwright@latest install chromium) or set PLAYWRIGHT_MODULE.');
}

/** Grow the viewport until no element scrolls vertically, so a normal shot holds everything. */
async function fit(page, width, height) {
  let h = height;
  for (let i = 0; i < 8; i++) {
    const extra = await page.evaluate(() => {
      let max = 0;
      for (const el of document.querySelectorAll('*')) {
        const oy = getComputedStyle(el).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        // Only a scroller on screen: the phone keeps the level-0 list mounted, slid off to the side.
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.right <= 1 || r.left >= innerWidth - 1 || getComputedStyle(el).visibility === 'hidden') continue;
        if (el.clientHeight > 40) max = Math.max(max, el.scrollHeight - el.clientHeight);
      }
      return max;
    });
    if (extra <= 2 || h >= 16000) break;
    h = Math.min(16000, h + extra);
    await page.setViewportSize({ width, height: h });
    await page.waitForTimeout(250);
  }
}

const settle = (page, ms = 1200) => page.waitForTimeout(ms);
const exact = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}$`);

/**
 * Sub-pages to shoot after a section: [file suffix, the row button's accessible name]. Each is
 * saved as `<key>-<sub>-phone.png` / `<key>-<sub>-desktop.png`.
 */
const SUBS = {
  agents: [['opencode', 'OpenCode'], ['claude', 'Claude Code']],
  accounts: [['work', 'Claude: Work'], ['personal', 'Codex: Personal']],
};
async function shootSubs(page, key, kind, reopen, W, H) {
  for (const [sub, name] of SUBS[key] ?? []) {
    try {
      await reopen();
      await page.getByRole('button', { name: exact(name) }).first().click({ timeout: 5000 });
      await settle(page, 900);
      await fit(page, W, H);
      await page.screenshot({ path: path.join(outDir, `${key}-${sub}-${kind}.png`) });
      console.log('shot', `${key}-${sub}-${kind}`);
    } catch (e) { console.log('MISS', `${key}-${sub}-${kind}`, e.message.split('\n')[0]); }
  }
}

async function shootPhone(browser) {
  const W = 390, H = 844;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const openList = async () => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto(base, { waitUntil: 'load' });
    await page.getByTestId('bottom-tabs').waitFor({ timeout: 20000 });
    await page.getByTestId('bottom-tabs').getByRole('button', { name: 'Settings' }).click();
    await settle(page, 800);
  };
  if (wantIndex) { await openList(); await fit(page, W, H); await page.screenshot({ path: path.join(outDir, 'index-phone.png') }); console.log('shot index-phone'); }
  for (const [key, label] of wanted) {
    try {
      await openList();
      const row = page.locator('button', { has: page.locator('span', { hasText: exact(label) }) }).first();
      await row.click({ timeout: 5000 });
      await settle(page);
      await fit(page, W, H);
      await page.screenshot({ path: path.join(outDir, `${key}-phone.png`) });
      console.log('shot', `${key}-phone`);
      await shootSubs(page, key, 'phone', async () => { await openList(); await page.locator('button', { has: page.locator('span', { hasText: exact(label) }) }).first().click({ timeout: 5000 }); await settle(page); }, W, H);
    } catch (e) { console.log('MISS', `${key}-phone`, e.message.split('\n')[0]); }
  }
  await ctx.close();
}

async function shootDesktop(browser) {
  const W = 1440, H = 900;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('dispatch:view', 'settings'); } catch { /* none */ } });
  const page = await ctx.newPage();
  const open = async () => {
    await page.setViewportSize({ width: W, height: H });
    await page.goto(base, { waitUntil: 'load' });
    await page.getByTestId('settings-view').waitFor({ timeout: 20000 });
    await settle(page, 800);
  };
  const nav = () => page.locator('[data-testid="settings-view"] > div').first();
  if (wantIndex) { await open(); await fit(page, W, H); await page.screenshot({ path: path.join(outDir, 'index-desktop.png') }); console.log('shot index-desktop'); }
  for (const [key, label] of wanted) {
    try {
      await open();
      await nav().getByRole('button', { name: exact(label) }).click({ timeout: 5000 });
      await settle(page);
      await fit(page, W, H);
      await page.screenshot({ path: path.join(outDir, `${key}-desktop.png`) });
      console.log('shot', `${key}-desktop`);
      await shootSubs(page, key, 'desktop', async () => { await open(); await nav().getByRole('button', { name: exact(label) }).click({ timeout: 5000 }); await settle(page); }, W, H);
    } catch (e) { console.log('MISS', `${key}-desktop`, e.message.split('\n')[0]); }
  }
  await ctx.close();
}

const browser = await launch();
try { await shootPhone(browser); await shootDesktop(browser); } finally { await browser.close(); }
