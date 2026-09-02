import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendRunLog, listRoles, parseRoleMd, readRoleMemory, readRunLogTail } from './definition.js';

const RAW = `---
name: rollup-nightly-check
project: shopify-product-rollup
agentType: researcher
model: sonnet
schedule: {"type":"daily","time":"05:30"}
tz: America/Indianapolis
authority: stage
wallClockCapMin: 30
---
Check last night's runs.`;

describe('parseRoleMd', () => {
  it('parses frontmatter + brief body', () => {
    const d = parseRoleMd('rollup-nightly-check', '/x', RAW);
    expect(d).toMatchObject({
      name: 'rollup-nightly-check', project: 'shopify-product-rollup', global: false,
      agentType: 'researcher', model: 'sonnet', tz: 'America/Indianapolis',
      authority: 'stage', wallClockCapMin: 30,
    });
    expect(d.schedule).toEqual({ type: 'daily', time: '05:30' });
    expect(d.brief).toBe("Check last night's runs.");
  });
  it('defaults: authority=stage, wallClockCapMin=45; global:true clears project', () => {
    const d = parseRoleMd('digest', '/x', '---\nglobal: true\nagentType: researcher\nschedule: {"type":"daily","time":"07:00"}\n---\nbody');
    expect(d.global).toBe(true);
    expect(d.project).toBeNull();
    expect(d.authority).toBe('stage');
    expect(d.wallClockCapMin).toBe(45);
  });
  it('rejects: missing schedule, unknown agentType, unknown authority, name mismatch', () => {
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\n---\nb')).toThrow(/schedule/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: wizard\nschedule: {"type":"manual"}\n---\nb')).toThrow(/agentType/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\nschedule: {"type":"manual"}\nauthority: yolo\n---\nb')).toThrow(/authority/);
    expect(() => parseRoleMd('r', '/x', '---\nname: other\nagentType: researcher\nschedule: {"type":"manual"}\n---\nb')).toThrow(/name/);
    expect(() => parseRoleMd('r', '/x', '---\nagentType: researcher\nschedule: {"type":"manual"}\nglobal: false\n---\nb')).toThrow(/project/); // non-global needs a project
  });
  it('parses CRLF role.md (Windows line endings)', () => {
    const crlf = RAW.replace(/\n/g, '\r\n');
    const d = parseRoleMd('rollup-nightly-check', '/x', crlf);
    expect(d).toMatchObject({
      name: 'rollup-nightly-check', project: 'shopify-product-rollup', global: false,
      agentType: 'researcher', model: 'sonnet', tz: 'America/Indianapolis',
      authority: 'stage', wallClockCapMin: 30,
    });
    expect(d.schedule).toEqual({ type: 'daily', time: '05:30' });
    expect(d.brief).toBe("Check last night's runs.");
  });
});

describe('listRoles / run log', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  it('lists valid role dirs, collects errors for invalid ones, ignores non-dirs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    fs.mkdirSync(path.join(tmp, 'good'));
    fs.writeFileSync(path.join(tmp, 'good', 'role.md'), `---
name: good
project: shopify-product-rollup
agentType: researcher
model: sonnet
schedule: {"type":"daily","time":"05:30"}
tz: America/Indianapolis
authority: stage
wallClockCapMin: 30
---
Check last night's runs.`);
    fs.mkdirSync(path.join(tmp, 'bad'));
    fs.writeFileSync(path.join(tmp, 'bad', 'role.md'), 'no frontmatter');
    fs.writeFileSync(path.join(tmp, 'stray.txt'), 'x');
    const { roles, errors } = listRoles(tmp);
    expect(roles.map((r) => r.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe('bad');
  });
  it('appendRunLog + readRunLogTail round-trip, tail-limited', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    const dir = path.join(tmp, 'r');
    for (let i = 1; i <= 5; i++) appendRunLog(dir, { n: i });
    const tail = readRunLogTail(dir, 3).map((l) => JSON.parse(l).n);
    expect(tail).toEqual([3, 4, 5]);
    expect(readRunLogTail(path.join(tmp, 'none'), 3)).toEqual([]);
  });
  it('readRoleMemory returns file content or empty string', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    const dir = path.join(tmp, 'r');
    fs.mkdirSync(dir);
    expect(readRoleMemory(dir)).toBe('');
    fs.writeFileSync(path.join(dir, 'memory.md'), 'prior session notes');
    expect(readRoleMemory(dir)).toBe('prior session notes');
  });
});
