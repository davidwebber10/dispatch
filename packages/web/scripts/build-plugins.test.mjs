import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { trimIconWeights, duotoneIcons, iconDefsName, staticClosure, shellPreloadLinks, sharedChunkNames, PHONE_MEDIA, DESKTOP_MEDIA } from './build-plugins.mjs';

const require = createRequire(import.meta.url);
const defsDir = path.join(path.dirname(require.resolve('@phosphor-icons/react')), 'defs');

describe('trimIconWeights', () => {
  it('keeps bold, duotone, fill and regular, and points thin and light at the regular drawing', async () => {
    const code = fs.readFileSync(path.join(defsDir, 'Gear.es.js'), 'utf8');
    const out = trimIconWeights(code);
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThan(code.length * 0.75);
    // Run both modules and compare the drawings.
    const load = async (text) => (await import(`data:text/javascript;base64,${Buffer.from(text.replace('from "react"', `from ${JSON.stringify('file://' + require.resolve('react'))}`)).toString('base64')}`)).default;
    const before = await load(code);
    const after = await load(out);
    expect([...after.keys()].sort()).toEqual(['bold', 'duotone', 'fill', 'light', 'regular', 'thin']);
    const json = (el) => JSON.stringify(el);
    for (const w of ['bold', 'duotone', 'fill', 'regular']) expect(json(after.get(w))).toBe(json(before.get(w)));
    expect(after.get('thin')).toBe(after.get('regular'));
    expect(after.get('light')).toBe(after.get('regular'));
  });

  it('handles every icon module of the installed package', () => {
    const files = fs.readdirSync(defsDir).filter((f) => f.endsWith('.es.js'));
    expect(files.length).toBeGreaterThan(1000);
    const failed = files.filter((f) => trimIconWeights(fs.readFileSync(path.join(defsDir, f), 'utf8')) === null);
    expect(failed).toEqual([]);
  });

  it('leaves a module of another form as it is', () => {
    expect(trimIconWeights('export default 1;')).toBeNull();
    expect(trimIconWeights('import * as a from "react";\nconst l = new Map([["bold", 1]]);\nexport { l as default };')).toBeNull();
  });

  it('iconDefsName matches the icon drawings only', () => {
    expect(iconDefsName('/x/node_modules/@phosphor-icons/react/dist/defs/Gear.es.js')).toBe('Gear');
    expect(iconDefsName('/x/node_modules/@phosphor-icons/react/dist/csr/Gear.es.js')).toBeNull();
    expect(iconDefsName('/x/src/defs/Gear.es.js')).toBeNull();
  });

  it('keepDuotone false points duotone at the regular drawing too', async () => {
    const code = fs.readFileSync(path.join(defsDir, 'Gear.es.js'), 'utf8');
    const out = trimIconWeights(code, { keepDuotone: false });
    expect(out.length).toBeLessThan(code.length * 0.55);
    const after = (await import(`data:text/javascript;base64,${Buffer.from(out.replace('from "react"', `from ${JSON.stringify('file://' + require.resolve('react'))}`)).toString('base64')}`)).default;
    expect(after.get('duotone')).toBe(after.get('regular'));
    expect(after.get('bold')).not.toBe(after.get('regular'));
    expect(after.get('fill')).not.toBe(after.get('regular'));
  });

  it('duotoneIcons reads the icons drawn in duotone, and gives up on a form it cannot read', () => {
    expect(duotoneIcons(['<Sparkle size={28} weight="duotone" />', 'x', '<a>\n<BrainIcon\n  size={1}\n  weight="duotone" /></a>'])).toEqual(new Set(['Sparkle', 'Brain']));
    expect(duotoneIcons(['<Gear weight="bold" />'])).toEqual(new Set());
    expect(duotoneIcons(["const w = on ? 'duotone' : 'bold';"])).toBeNull();
    expect(duotoneIcons(['<Gear weight="duotone" /> // duotone'])).toBeNull();
  });

  it('the app source draws only Sparkle and Brain in duotone (the build keeps duotone for these)', () => {
    const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
    const texts = fs.readdirSync(src, { recursive: true }).filter((f) => /\.tsx?$/.test(String(f)) && !/\.test\.tsx?$/.test(String(f))).map((f) => fs.readFileSync(path.join(src, String(f)), 'utf8'));
    expect(duotoneIcons(texts)).toEqual(new Set(['Sparkle', 'Brain']));
  });
});

describe('shell preload links', () => {
  const chunks = {
    'assets/index.js': { imports: ['assets/react.js'] },
    'assets/react.js': {},
    'assets/Phone.js': { imports: ['assets/index.js', 'assets/shared.js', 'assets/phoneOnly.js'] },
    'assets/Desktop.js': { imports: ['assets/index.js', 'assets/shared.js', 'assets/thread.js'] },
    'assets/shared.js': { imports: ['assets/react.js'] },
    'assets/phoneOnly.js': {},
    'assets/thread.js': { imports: ['assets/shared.js'] },
    'assets/Settings.js': { imports: ['assets/index.js'] },
  };

  it('staticClosure follows static imports at any depth and stops at a file it saw', () => {
    expect(staticClosure(chunks, ['assets/Desktop.js']).sort()).toEqual(['assets/Desktop.js', 'assets/index.js', 'assets/react.js', 'assets/shared.js', 'assets/thread.js']);
  });

  it('a chunk of one shell gets that shell\'s media; a chunk of both gets none; the entry\'s chunks get no second link', () => {
    const links = shellPreloadLinks({
      entry: staticClosure(chunks, ['assets/index.js']),
      phone: staticClosure(chunks, ['assets/Phone.js']),
      desktop: staticClosure(chunks, ['assets/Desktop.js']),
    });
    expect(links).toEqual([
      { href: 'assets/shared.js' },
      { href: 'assets/Phone.js', media: PHONE_MEDIA },
      { href: 'assets/phoneOnly.js', media: PHONE_MEDIA },
      { href: 'assets/Desktop.js', media: DESKTOP_MEDIA },
      { href: 'assets/thread.js', media: DESKTOP_MEDIA },
    ]);
    expect(links.some((l) => l.href === 'assets/Settings.js')).toBe(false);
  });
});

describe('sharedChunkNames', () => {
  // The first pass, as Rollup places the modules: one shared chunk for each combination of roots.
  const chunk = (fileName, moduleIds, imports = [], kind = '') => ({ fileName, moduleIds, imports, isEntry: kind === 'entry', isDynamicEntry: kind === 'dyn' });
  const pass1 = [
    chunk('index.js', ['/main', '/store'], ['react.js'], 'entry'),
    chunk('react.js', ['/node_modules/react/index.js']),
    chunk('Phone.js', ['/Phone', '/phoneList'], ['index.js', 'react.js', 'a.js', 'c.js'], 'dyn'),
    chunk('Desktop.js', ['/Desktop', '/rail'], ['index.js', 'react.js', 'a.js', 'b.js'], 'dyn'),
    chunk('Thread.js', ['/Thread'], ['index.js', 'd.js', 'a.js'], 'dyn'),
    chunk('Overseer.js', ['/Overseer'], ['index.js', 'd.js', 'b.js', 'c.js'], 'dyn'),
    chunk('Settings.js', ['/Settings', '/sections'], ['index.js', 'e.js'], 'dyn'),
    chunk('Wizard.js', ['/Wizard'], ['index.js', 'e.js'], 'dyn'),
    chunk('a.js', ['/card', '/dnd'], ['react.js']),          // both shells and the thread view
    chunk('b.js', ['/ledger'], ['a.js']),                     // the desktop shell and the Control Plane
    chunk('c.js', ['/phoneMenu']),                            // the phone shell and the Control Plane
    chunk('d.js', ['/chat', '/tool']),                        // two views, no shell
    chunk('e.js', ['/secrets']),                              // two views, no shell
  ];
  const names = sharedChunkNames(pass1, (id) => id === '/Phone' || id === '/Desktop', (id) => id.includes('/node_modules/react/'));

  it('the entry\'s modules are named "index"', () => {
    expect(names.get('/main')).toBe('index');
    expect(names.get('/store')).toBe('index');
  });

  it('a module of one root gets no name', () => {
    for (const id of ['/Phone', '/phoneList', '/Desktop', '/rail', '/Thread', '/Overseer', '/Settings', '/sections', '/Wizard']) expect(names.has(id), id).toBe(false);
  });

  it('code that a shell shares goes to "common"; code that only views share goes to "views"', () => {
    for (const id of ['/card', '/dnd', '/ledger', '/phoneMenu']) expect(names.get(id), id).toBe('common');
    for (const id of ['/chat', '/tool', '/secrets']) expect(names.get(id), id).toBe('views');
  });

  it('a pinned module (a vendor group) gets no name here', () => {
    expect(names.has('/node_modules/react/index.js')).toBe(false);
  });

  it('the result has three chunk names at most, whatever the number of combinations', () => {
    expect([...new Set(names.values())].sort()).toEqual(['common', 'index', 'views']);
  });
});
