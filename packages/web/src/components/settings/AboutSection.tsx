import { useSetup } from '../../stores/setup';
import { UpdatesSection } from './UpdatesSection';
import { TelemetrySetting } from './TelemetrySetting';
import { sectionLabel, ghostBtn, Divider } from './ui';

/**
 * Settings → About & updates: the running version and updates, the setup wizard, and the anonymous
 * usage stats switch. `onDone` dismisses the surrounding chrome so the wizard is not buried: on
 * desktop it leaves the settings page; on a phone settings is a screen, so it is omitted.
 */
export function AboutSection({ onDone }: { onDone?: () => void }) {
  const openSetup = useSetup((s) => s.open);
  return (
    <>
      <UpdatesSection />
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>SETUP</span>
        <button onClick={() => { openSetup(); onDone?.(); }} style={{ ...ghostBtn, alignSelf: 'flex-start', color: 'var(--color-text-primary)' }}>Re-run setup wizard</button>
      </div>

      {/* Brings its own divider and heading, and renders nothing until the daemon answers. */}
      <TelemetrySetting />
    </>
  );
}
