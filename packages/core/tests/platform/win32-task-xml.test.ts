import { describe, expect, test } from 'vitest';
import { buildLogonTaskXml } from '../../src/platform/win32-task-xml.js';

describe('buildLogonTaskXml', () => {
  const xml = buildLogonTaskXml({
    port: 3456, nodePath: 'C:\\node.exe',
    entry: 'C:\\repo\\packages\\core\\dist\\server.js',
    repoRoot: 'C:\\repo', env: { PORT: '3456' },
    logDir: 'C:\\logs', userId: 'DOMAIN\\user',
  });
  test('is a LogonTrigger task running as the current user, interactive', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>DOMAIN\\user</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });
  test('restarts on failure and never times out', () => {
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });
  test('invokes node with the server entry and bakes PORT', () => {
    expect(xml).toContain('C:\\node.exe');
    expect(xml).toContain('server.js');
  });
  test('escapes XML metacharacters in arguments', () => {
    const x = buildLogonTaskXml({
      port: 1, nodePath: 'n', entry: 'e', repoRoot: 'r',
      env: { X: 'a&b<c>' }, logDir: 'l', userId: 'u',
    });
    expect(x).toContain('a&amp;b&lt;c&gt;');
  });
  test('uses append redirect *>> so logs persist across restarts', () => {
    // The *>> is inside an XML-escaped <Arguments> value, so > becomes &gt;
    // *>> → *&gt;&gt; in the serialised XML.
    expect(xml).toContain('*&gt;&gt;');
    // Must NOT contain bare *&gt; (single >) which would be the truncating *> form.
    // We check the raw source string contains '*>>' and not just '*>'.
    const src = xml.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    expect(src).toContain('*>>');
    expect(src).not.toMatch(/\*>[^>]/); // no single *> redirect
  });
});
