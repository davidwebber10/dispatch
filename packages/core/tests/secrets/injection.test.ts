import { describe, it, expect } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { SecretsService } from '../../src/secrets/service.js';

it('getServerSpec is null when Doppler is not connected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const svc = new SecretsService(dir);
  expect(svc.getServerSpec()).toBeNull();
  expect(svc.getInjection()).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null });
});
