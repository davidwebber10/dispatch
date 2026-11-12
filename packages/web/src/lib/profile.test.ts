import { afterEach, describe, expect, it } from 'vitest';
import { FEATURES, can, featureFor, type Feature } from './profile';
import { DEFAULT_HOST_CONTEXT, hostContext, isBusinessPreview, parseHostContext, setBusinessPreview, setHostContextForTest, usesOsLook, usesPlainWording, PREVIEW_BUSINESS_KEY } from './hostContext';
import { hostCopy, hostDetail, PLAIN, PRODUCT_NAME } from './hostCopy';
import { themeFor, pickableThemes, defaultThemeSetting, osLight, osDark, dispatchDark, dispatchLight } from '../themes';

afterEach(() => { localStorage.removeItem(PREVIEW_BUSINESS_KEY); setHostContextForTest({}); });

const keys = Object.keys(FEATURES) as Feature[];

describe('the feature map', () => {
  it('the developer profile shows every feature', () => {
    for (const k of keys) expect(featureFor(k, 'developer'), k).toBe(true);
  });

  it('the business profile hides the power-user features and keeps the rest', () => {
    const hidden = keys.filter((k) => !featureFor(k, 'business')).sort();
    expect(hidden).toEqual([
      'analytics', 'control-plane', 'effort-picker', 'missions', 'model-picker', 'review.diff',
      'settings.agents', 'settings.devices', 'settings.editor', 'settings.integrations', 'settings.plugins',
      'settings.secrets', 'settings.servers', 'settings.skills', 'settings.telemetry', 'settings.tools', 'settings.usage',
      'themes.all', 'threads.browser', 'threads.cli', 'threads.git', 'threads.shell', 'tool-json',
    ]);
    for (const k of ['threads.chat', 'tabs.notes', 'tabs.files', 'previews', 'needs-you', 'automations', 'endless', 'accounts', 'approvals', 'attachments', 'update'] as Feature[]) {
      expect(featureFor(k, 'business'), k).toBe(true);
    }
  });

  it('every key explains itself', () => {
    for (const k of keys) expect(FEATURES[k].note.length, k).toBeGreaterThan(5);
  });

  it('can() follows the page profile', () => {
    setHostContextForTest({});
    expect(can('threads.cli')).toBe(true);
    setHostContextForTest({ profile: 'business', hosted: true });
    expect(can('threads.cli')).toBe(false);
    expect(can('threads.chat')).toBe(true);
  });
});

describe('the host context', () => {
  it('a page with no meta is a local developer', () => {
    expect(parseHostContext(undefined)).toEqual(DEFAULT_HOST_CONTEXT);
    setHostContextForTest();
    expect(hostContext()).toEqual(DEFAULT_HOST_CONTEXT);
  });

  it('accepts only the known shape', () => {
    expect(parseHostContext({ profile: 'admin', hosted: 'yes', osBaseUrl: 'javascript:x', ownerEmail: 3 })).toEqual(DEFAULT_HOST_CONTEXT);
    expect(parseHostContext({ profile: 'business', hosted: true, osBaseUrl: 'https://os.example', ownerEmail: 'a@b' }))
      .toEqual({ profile: 'business', hosted: true, osBaseUrl: 'https://os.example', ownerEmail: 'a@b' });
  });

  it('reads the meta the daemon writes', () => {
    const meta = document.createElement('meta');
    meta.name = 'dispatch-host-context';
    meta.content = JSON.stringify({ profile: 'business', hosted: true, osBaseUrl: 'https://os.example', ownerEmail: null });
    document.head.appendChild(meta);
    try {
      setHostContextForTest();
      expect(hostContext().profile).toBe('business');
      expect(hostContext().osBaseUrl).toBe('https://os.example');
    } finally {
      meta.remove();
    }
  });
});

describe('the business preview', () => {
  it('a developer sees the business map, the OS look and plain words; the real profile stays', () => {
    setHostContextForTest({}, true);
    expect(isBusinessPreview()).toBe(true);
    expect(hostContext().profile).toBe('business');
    expect(can('threads.cli')).toBe(false);
    expect(usesOsLook()).toBe(true);
    expect(usesPlainWording()).toBe(true);
  });

  it('is not possible for a business person (nothing to preview)', () => {
    setHostContextForTest({ profile: 'business', hosted: true }, true);
    expect(isBusinessPreview()).toBe(false);
  });

  it('the switch saves the choice and reloads', () => {
    setHostContextForTest({});
    let reloaded = 0;
    setBusinessPreview(true, () => { reloaded++; });
    expect(localStorage.getItem(PREVIEW_BUSINESS_KEY)).toBe('1');
    setBusinessPreview(false, () => { reloaded++; });
    expect(localStorage.getItem(PREVIEW_BUSINESS_KEY)).toBeNull();
    expect(reloaded).toBe(2);
  });
});

describe('themes by host', () => {
  it('a local install keeps the Dispatch defaults', () => {
    setHostContextForTest({});
    expect(defaultThemeSetting()).toBe(dispatchDark.id);
    expect(themeFor('system', true).id).toBe(dispatchDark.id);
    expect(themeFor('system', false).id).toBe(dispatchLight.id);
  });

  it('a hosted workspace defaults to System, which is the OS pair', () => {
    setHostContextForTest({ hosted: true });
    expect(defaultThemeSetting()).toBe('system');
    expect(themeFor('system', true).id).toBe(osDark.id);
    expect(themeFor('system', false).id).toBe(osLight.id);
    expect(themeFor('gone', false).id).toBe(osLight.id);
  });

  it('a business person picks only the OS pair', () => {
    expect(pickableThemes(false).map((t) => t.id)).toEqual([osLight.id, osDark.id]);
    expect(pickableThemes(true).length).toBe(14);
  });
});

describe('hostCopy', () => {
  it('a local install keeps the old sentence', () => {
    setHostContextForTest({});
    expect(hostCopy('conn.reconnecting', 'Reconnecting…')).toBe('Reconnecting…');
    expect(hostDetail('daemon')).toBeNull();
  });

  it('a hosted workspace says it plainly', () => {
    setHostContextForTest({ hosted: true, profile: 'business' });
    expect(hostCopy('conn.reconnecting', 'Reconnecting…')).toBe('Your workspace is reconnecting…');
    expect(hostDetail('The daemon restarted')).toBeNull();
    setHostContextForTest({ hosted: true, profile: 'developer' });
    expect(hostDetail('The daemon restarted')).toBe('The daemon restarted');
  });

  it('no plain sentence has a machine word', () => {
    for (const [k, v] of Object.entries(PLAIN)) {
      expect(v, k).not.toMatch(/\b(daemon|container|box|PTY|tailscale|localhost|git|server|session limit|pairing)\b/i);
    }
  });

  it('the product has one name', () => {
    expect(PRODUCT_NAME).toBe('Dispatch');
  });
});
