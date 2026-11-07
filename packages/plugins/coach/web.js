// Coach — a bundled Dispatch plugin (docs/superpowers/specs/2026-11-07-coach-design.md).
// It looks at how you work with AI and suggests one small next step at a natural break: a card
// under the message box, a tab in the right column, and its own screen. The worker
// (worker/index.mjs) watches the thread events and proposes candidates; this part shows cards,
// takes feedback, and keeps the memory you can see and edit. It never sends anything by itself.
import { withDefaults } from './lib/settings.mjs';

export function createCoach(d, deps = {}) {
  const { h, storage, settings, events } = d;
  // The id the host gave this copy: a copy to local runs under its own id.
  const PLUGIN = d.id || 'coach';

  // ── state: the plugin's documents, loaded once and kept current by plugin:data events ──
  const store = d.zustand.create(() => ({
    loaded: false,
    settings: withDefaults(null),
    cadence: {},
  }));

  async function load() {
    const [s, cadence] = await Promise.all([
      settings.get(PLUGIN, null).catch(() => null),
      storage.get(PLUGIN, 'cadence', {}).catch(() => ({})),
    ]);
    store.setState({ loaded: true, settings: withDefaults(s), cadence: cadence || {} });
  }
  const ready = load();
  events.on(['plugin:data', 'plugin:settings'], (e) => { if (e.id === PLUGIN) void load(); });

  async function saveCadence(next) { store.setState({ cadence: next }); await storage.set(PLUGIN, 'cadence', next); }
  const HOUR = 3600 * 1000;
  const muteFor = (ms) => saveCadence({ ...store.getState().cadence, mutedUntil: new Date(Date.now() + ms).toISOString() });
  const unmute = () => saveCadence({ ...store.getState().cadence, mutedUntil: null });

  function Card() { return null; }

  function CoachView() {
    return h('div', { style: { padding: '22px 26px 40px', maxWidth: 820, margin: '0 auto' } },
      h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Coach'),
      h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, 'One small next step at a time, from how you actually work. Your Coach data stays on this machine and is private to you.'));
  }

  function CoachTab() {
    return h('div', { style: { padding: 12, fontSize: 13, color: 'var(--color-text-secondary)' } }, 'The Coach has nothing for this thread yet.');
  }

  function Settings() {
    return h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)' } }, 'Coach settings.');
  }

  d.register(PLUGIN, {
    views: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachView }],
    settings: [{ id: 'coach', label: 'Coach', blurb: 'How often, what it may spend, what it remembers', icon: 'sparkle', Component: Settings }],
    slots: [{ id: 'card', slot: 'composer.before', Component: Card }],
    inspectorTabs: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachTab }],
    commands: [
      { id: 'mute-coach', label: 'Mute coach', run: () => { void muteFor(HOUR); } },
      { id: 'unmute-coach', label: 'Unmute coach', run: () => { void unmute(); } },
    ],
  });

  return { store, ready, deps };
}

export default function activate(d) {
  createCoach(d);
}
