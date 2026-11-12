import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkBundle, roundTrips, announcedFiles, BUDGETS } from './check-bundle.mjs';

describe('checkBundle', () => {
  let dist;
  beforeEach(() => { dist = fs.mkdtempSync(path.join(os.tmpdir(), 'check-bundle-')); fs.mkdirSync(path.join(dist, 'assets')); fs.mkdirSync(path.join(dist, '.vite')); });
  afterEach(() => { fs.rmSync(dist, { recursive: true, force: true }); });

  /** A file of `bytes` random bytes: gzip and brotli cannot make it smaller, so its size is its compressed size. */
  const file = (name, bytes) => { fs.writeFileSync(path.join(dist, name), crypto.randomBytes(bytes)); return name; };

  /**
   * A build as the app's: an entry with a vendor chunk, a shell for each width, a shared chunk, the
   * thread view, and Settings on demand. `o` changes one thing for a test.
   */
  function build(o = {}) {
    const sizes = { entry: 160_000, vendor: 40_000, phone: 10_000, desktop: 15_000, thread: 30_000, settings: 30_000, css: 5_000, ...o.sizes };
    const m = {
      'index.html': { file: file('assets/index-AAA.js', sizes.entry), isEntry: true, src: 'index.html', imports: ['_vendor-AAA.js'], dynamicImports: ['src/components/mobile/MobileApp.tsx', 'src/components/layout/DesktopShell.tsx'], css: [file('assets/index-AAA.css', sizes.css)] },
      '_vendor-AAA.js': { file: file('assets/vendor-AAA.js', sizes.vendor), name: 'vendor' },
      'src/components/mobile/MobileApp.tsx': { file: file('assets/MobileApp-AAA.js', sizes.phone), src: 'src/components/mobile/MobileApp.tsx', isDynamicEntry: true, imports: ['index.html', ...(o.phoneImports ?? [])], dynamicImports: ['_views-AAA.js', 'src/components/settings/allSections.ts'] },
      'src/components/layout/DesktopShell.tsx': { file: file('assets/DesktopShell-AAA.js', sizes.desktop), src: 'src/components/layout/DesktopShell.tsx', isDynamicEntry: true, imports: ['index.html'], dynamicImports: ['_views-AAA.js', 'src/components/settings/allSections.ts'] },
      '_views-AAA.js': { file: file('assets/views-AAA.js', sizes.thread), name: 'views', isDynamicEntry: true, imports: ['index.html'] },
      'src/components/settings/allSections.ts': { file: file('assets/allSections-AAA.js', sizes.settings), src: 'src/components/settings/allSections.ts', isDynamicEntry: true, imports: ['index.html'] },
      '_terminal-AAA.js': { file: file('assets/terminal-AAA.js', 1000), name: 'terminal' },
    };
    fs.writeFileSync(path.join(dist, '.vite/manifest.json'), JSON.stringify(o.manifest ? o.manifest(m) : m));
    const links = o.links ?? [
      '<link rel="modulepreload" crossorigin href="./assets/vendor-AAA.js">',
      '<link rel="stylesheet" crossorigin href="./assets/index-AAA.css">',
      '<link rel="modulepreload" crossorigin href="./assets/MobileApp-AAA.js" media="(max-width: 768px)">',
      '<link rel="modulepreload" crossorigin href="./assets/DesktopShell-AAA.js" media="(min-width: 769px)">',
      '<link rel="modulepreload" crossorigin href="./assets/views-AAA.js" media="(min-width: 769px)">',
    ];
    fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><head><script src="theme-boot.js"></script><script type="module" crossorigin src="./assets/index-AAA.js"></script>${links.join('')}</head><body></body></html>`);
  }

  it('fails over the budget, passes under it', () => {
    build();
    const under = checkBundle(dist);
    expect(under.errors).toEqual([]);
    expect(under.ok).toBe(true);
    expect(under.report.entry.gzip).toBeGreaterThan(160_000);
    expect(under.report.entry.gzip).toBeLessThan(161_000);

    build({ sizes: { entry: BUDGETS.entryGzip + 5_000 } });
    const over = checkBundle(dist);
    expect(over.ok).toBe(false);
    expect(over.errors.join('\n')).toMatch(/the entry chunk assets\/index-AAA\.js is \d+ bytes gzip: over the budget of 260000/);
  });

  it('reports the first-paint path of each width: its files, its sizes and the round trips', () => {
    build();
    const { report } = checkBundle(dist);
    expect(report.paths.phone.js.sort()).toEqual(['assets/MobileApp-AAA.js', 'assets/index-AAA.js', 'assets/vendor-AAA.js']);
    expect(report.paths.desktop.js.sort()).toEqual(['assets/DesktopShell-AAA.js', 'assets/index-AAA.js', 'assets/vendor-AAA.js', 'assets/views-AAA.js']);
    expect(report.paths.phone.css).toEqual(['assets/index-AAA.css']);
    expect(report.paths.phone.raw).toBe(160_000 + 40_000 + 10_000 + 5_000);
    expect(report.paths.phone.brotli).toBeGreaterThanOrEqual(215_000);
    expect(report.paths.phone.roundTrips).toBe(4);
    expect(report.chunkCount).toBe(7);
  });

  it('fails when a first-paint path is over its brotli budget or has too many files', () => {
    build({ sizes: { vendor: 250_000 } });
    const r = checkBundle(dist);
    expect(r.errors.join('\n')).toMatch(new RegExp(`phone: the first-paint path is \\d+ bytes brotli: over the budget of ${BUDGETS.firstPaintBrotli.phone}`));
    build();
    const few = checkBundle(dist, { budgets: { firstPaintFiles: { phone: 2, desktop: 4 } } });
    expect(few.errors).toEqual(['phone: the first-paint path has 3 JS files: over the budget of 2']);
  });

  it('fails when the phone path holds the desktop shell', () => {
    build({ phoneImports: ['src/components/layout/DesktopShell.tsx'] });
    const r = checkBundle(dist);
    expect(r.errors.some((e) => e.startsWith('phone: the first-paint path holds the desktop shell (assets/DesktopShell-AAA.js)'))).toBe(true);
  });

  it('fails when a path holds a chunk that must load on demand', () => {
    build({ phoneImports: ['src/components/settings/allSections.ts'] });
    expect(checkBundle(dist).errors.some((e) => e.startsWith('phone: the first-paint path holds src/components/settings/allSections.ts'))).toBe(true);
    build({ phoneImports: ['_terminal-AAA.js'] });
    expect(checkBundle(dist).errors.some((e) => e.startsWith('phone: the first-paint path holds the "terminal" chunk'))).toBe(true);
    // The thread view is on demand for the phone, and in the desktop's path.
    build({ phoneImports: ['_views-AAA.js'] });
    expect(checkBundle(dist).errors.some((e) => e.startsWith('phone: the first-paint path holds the "views" chunk (assets/views-AAA.js)'))).toBe(true);
    expect(checkBundle(dist).errors.some((e) => e.startsWith('desktop:'))).toBe(false);
  });

  it('fails when the build has no "views" chunk for the desktop', () => {
    build({ manifest: (m) => { delete m['_views-AAA.js']; return m; } });
    expect(checkBundle(dist).errors).toContain('desktop: the build has no "views" chunk');
  });

  it('fails when a shell is not a chunk of its own', () => {
    build({ manifest: (m) => { delete m['src/components/mobile/MobileApp.tsx']; return m; } });
    expect(checkBundle(dist).errors).toContain('phone: src/components/mobile/MobileApp.tsx is not a chunk of its own (it must be loaded with import())');
  });

  it('fails when index.html does not announce a first-paint chunk for that width (a request waterfall)', () => {
    build({ links: [
      '<link rel="modulepreload" crossorigin href="./assets/vendor-AAA.js">',
      '<link rel="stylesheet" crossorigin href="./assets/index-AAA.css">',
      '<link rel="modulepreload" crossorigin href="./assets/DesktopShell-AAA.js" media="(min-width: 769px)">',
      '<link rel="modulepreload" crossorigin href="./assets/views-AAA.js" media="(min-width: 769px)">',
    ] });
    expect(checkBundle(dist).errors).toEqual(['phone: assets/MobileApp-AAA.js is in the first-paint path, and index.html does not announce it for a width of 390px (one more round trip)']);
  });

  it('fails when index.html announces a chunk that the width does not need', () => {
    build({ links: [
      '<link rel="modulepreload" crossorigin href="./assets/vendor-AAA.js">',
      '<link rel="stylesheet" crossorigin href="./assets/index-AAA.css">',
      '<link rel="modulepreload" crossorigin href="./assets/MobileApp-AAA.js" media="(max-width: 768px)">',
      '<link rel="modulepreload" crossorigin href="./assets/DesktopShell-AAA.js">',
      '<link rel="modulepreload" crossorigin href="./assets/views-AAA.js" media="(min-width: 769px)">',
    ] });
    expect(checkBundle(dist).errors).toEqual(['phone: index.html announces assets/DesktopShell-AAA.js for a width of 390px, and it is not in the first-paint path']);
  });

  it('says what is missing when there is no build', () => {
    const r = checkBundle(path.join(dist, 'nope'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/build first/);
  });
});

describe('helpers', () => {
  it('roundTrips: slow start from 10 segments', () => {
    expect(roundTrips(1)).toBe(1);
    expect(roundTrips(14_600)).toBe(1);
    expect(roundTrips(14_601)).toBe(2);
    expect(roundTrips(43_800)).toBe(2);
    expect(roundTrips(100_000)).toBe(3);
    expect(roundTrips(219_000)).toBe(4);
    expect(roundTrips(441_000)).toBe(5);
  });

  it('announcedFiles reads the scripts and the preload links with their media', () => {
    expect(announcedFiles('<script src="theme-boot.js"></script><script type="module" crossorigin src="./assets/index-A.js"></script><link rel="modulepreload" crossorigin href="./assets/x-A.js" media="(max-width: 768px)"><link rel="icon" href="icons/f.png">')).toEqual([
      { href: 'theme-boot.js' }, { href: 'assets/index-A.js' }, { href: 'assets/x-A.js', media: '(max-width: 768px)' },
    ]);
  });
});

// Final review of v4.5.0: no script ran this check, so nothing enforced the budget.
describe('the web build runs the check', () => {
  // The install build (`dispatch update` runs it on the owner's machine) must never fail on the
  // budget: a release a few kB over would leave the owner with no update. The build reports;
  // a release check runs the script without --warn, which exits 1 over budget.
  it('`pnpm build` runs check-bundle.mjs --warn after `vite build`: it reports, it does not fail the install', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const steps = pkg.scripts.build.split('&&').map((s) => s.trim());
    const vite = steps.indexOf('vite build');
    const check = steps.indexOf('node scripts/check-bundle.mjs --warn');
    expect(vite).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(vite);
    expect(pkg.scripts['check-bundle']).toBe('node scripts/check-bundle.mjs');
  });

  it('--warn exits 0 over budget and prints FAILED; without it the exit code is 1', async () => {
    const { execFileSync, spawnSync } = await import('node:child_process');
    const script = path.join(__dirname, 'check-bundle.mjs');
    const empty = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'cb-'));
    const warn = spawnSync(process.execPath, [script, empty, '--warn'], { encoding: 'utf8' });
    const strict = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });
    expect(warn.status).toBe(0);
    expect(warn.stdout + warn.stderr).toMatch(/FAILED|WARNING/);
    expect(strict.status).toBe(1);
    void execFileSync;
  });
});
