import { describe, it, expect } from 'vitest';
// The bundled Coach plugin is plain JS; the tests import its modules directly.
import { createCoach } from '../../../plugins/coach/web.js';
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLDS, withDefaults } from '../../../plugins/coach/lib/settings.mjs';
import manifest from '../../../plugins/coach/plugin.json';
import { fakeD } from './coach-test-utils';

describe('Coach: the plugin skeleton (coach plan Task 7)', () => {
  it('the manifest is the Coach: id, permissions, contributions and the weekly job', () => {
    expect(manifest).toMatchObject({ id: 'coach', name: 'Coach', web: 'web.js' });
    expect((manifest as { enabledByDefault?: boolean }).enabledByDefault).toBeUndefined(); // off by default (owner, 2026-11-08)
    expect(manifest.permissions).toEqual(['read:prompts', 'read:threads', 'read:projects', 'read:usage', 'read:analytics', 'model:assist', 'notify:push']);
    expect(manifest.contributes.views.map((v: { id: string }) => v.id)).toEqual(['coach']);
    expect(manifest.contributes.slots).toEqual(['composer.before']);
    expect(manifest.worker).toMatchObject({ command: 'node', args: ['worker/index.mjs'], jobs: [{ id: 'weekly', cron: '0 8 * * 1' }] });
  });

  it('activate registers the view, the settings section, the card slot, the right-column tab and the mute commands', async () => {
    const d = fakeD();
    const coach = createCoach(d);
    await coach.ready;
    const c = d.registered.coach as Record<string, { id: string; slot?: string }[]>;
    expect(c.views.map((v) => v.id)).toEqual(['coach']);
    expect(c.settings.map((v) => v.id)).toEqual(['coach']);
    expect(c.slots.map((v) => [v.id, v.slot])).toEqual([['card', 'composer.before']]);
    expect(c.inspectorTabs.map((v) => v.id)).toEqual(['coach']);
    expect(c.commands.map((v) => v.id)).toEqual(['mute-coach', 'unmute-coach']);
  });

  it('settings start from the defaults, and a saved partial setting keeps the other defaults', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ howOften: 'normal', maxPerDay: 3, maxPerSession: 1, quietHours: null, phone: false, tipTypes: { prompt: true, thinkBigger: true }, leaveAlone: [], thoroughness: 'balanced', model: { mode: 'auto' }, budgetPercentWeekly: 3, budgetUsdWeekly: 5, recap: { inApp: true, push: false } });
    expect(DEFAULT_SETTINGS.advanced.minConfidence).toBe(0.85);
    expect(DEFAULT_SETTINGS.advanced.thresholds).toEqual(DEFAULT_THRESHOLDS);
    const s = withDefaults({ howOften: 'chatty', advanced: { thresholds: { idleWait: { minutes: 5 } } } });
    expect(s.howOften).toBe('chatty');
    expect(s.maxPerSession).toBe(1);
    expect(s.advanced.thresholds.idleWait.minutes).toBe(5);
    expect(s.advanced.thresholds.repeatedPrompt).toEqual(DEFAULT_THRESHOLDS.repeatedPrompt);
    expect(s.advanced.minConfidence).toBe(0.85);
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
    const d = fakeD({ settings: { howOften: 'quiet' } });
    const coach = createCoach(d);
    await coach.ready;
    expect(coach.store.getState().settings.howOften).toBe('quiet');
    expect(coach.store.getState().settings.maxPerDay).toBe(3);
  });
});
