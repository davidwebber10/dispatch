import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { buildSdk } from './sdk';
import { createPluginSdk } from './facade';

/**
 * The SDK type file (`packages/sdk/index.d.ts`, published as `@dispatchd/sdk`) names what the app
 * really hands a plugin (engineering program 2026-11-09, W3-F). `sdk.types-check.ts` checks the
 * types under `tsc`; this test checks the names at run time, so a member that exists in only one of
 * the two places fails here with its name.
 */
const file = path.resolve(__dirname, '../../../sdk/index.d.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function declared(name: string): ts.InterfaceDeclaration {
  const found = source.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name);
  if (!found) throw new Error(`index.d.ts declares no interface ${name}`);
  return found;
}
const nameOf = (m: ts.TypeElement): string => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : '');
/** The member names of an interface, and of each member that is an object type literal. */
function shape(name: string): { top: string[]; nested: Record<string, string[]> } {
  const top: string[] = []; const nested: Record<string, string[]> = {};
  for (const m of declared(name).members) {
    const key = nameOf(m);
    if (!key) continue;
    top.push(key);
    if (ts.isPropertySignature(m) && m.type && ts.isTypeLiteralNode(m.type)) nested[key] = m.type.members.map(nameOf).filter(Boolean).sort();
  }
  return { top: top.sort(), nested };
}
const isReact = (v: unknown): boolean => !!v && typeof v === 'object' && 'createElement' in (v as object);
function runtime(obj: object, namespaces: string[]): { top: string[]; nested: Record<string, string[]> } {
  const nested: Record<string, string[]> = {};
  for (const k of namespaces) nested[k] = Object.keys((obj as Record<string, object>)[k]).sort();
  return { top: Object.keys(obj).sort(), nested };
}

describe('the SDK type file matches the SDK (W3-F)', () => {
  it('DispatchSdkV2 declares every member of the version 2 object, and no other', () => {
    const d = createPluginSdk('p');
    const want = shape('DispatchSdkV2');
    // Every member the file declares as an object literal is a namespace to compare key by key.
    const namespaces = Object.keys(want.nested).filter((k) => !isReact((d as unknown as Record<string, unknown>)[k]));
    const got = runtime(d, namespaces);
    expect(got.top).toEqual(want.top);
    for (const k of namespaces) expect(got.nested[k], `DispatchSdkV2.${k}`).toEqual(want.nested[k]);
    for (const k of ['docs', 'settings', 'threads', 'projects', 'worker', 'events', 'actions', 'hooks', 'model', 'plugin', 'files']) expect(namespaces, k).toContain(k);
    expect(want.top).not.toContain('api');
    expect(want.top).not.toContain('stores');
  });

  it('DispatchSdk (version 1) still declares every member of the version 1 object, with api and stores marked deprecated', () => {
    const d = buildSdk();
    const want = shape('DispatchSdk');
    expect(Object.keys(d).sort()).toEqual(want.top);
    for (const k of ['storage', 'settings', 'actions', 'worker', 'events']) expect(Object.keys((d as unknown as Record<string, object>)[k]).sort(), `DispatchSdk.${k}`).toEqual(want.nested[k]);
    for (const k of ['api', 'stores']) {
      const member = declared('DispatchSdk').members.find((m) => nameOf(m) === k)!;
      expect(ts.getJSDocDeprecatedTag(member), `DispatchSdk.${k} @deprecated`).toBeDefined();
    }
  });

  it('the data types a plugin reads are declared with the documented keys', () => {
    const d = createPluginSdk('p');
    expect(shape('ThreadInfo').top).toEqual(['archived', 'createdAt', 'id', 'kind', 'label', 'lastActivityAt', 'projectId', 'status']);
    expect(shape('ProjectInfo').top).toEqual(['archived', 'id', 'name', 'workingDir']);
    expect(shape('ThreadStatusInfo').top).toEqual(['activity', 'stalledSince', 'state', 'status']);
    expect(d.threads.list()).toEqual([]);
  });

  it('SdkVersion names both versions', () => {
    const alias = source.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'SdkVersion')!;
    expect(alias.type.getText(source).replace(/\s/g, '')).toBe('1|2');
  });
});
