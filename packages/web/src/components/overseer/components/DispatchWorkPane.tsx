import { overseerRootStyle } from '../atoms';
import { LedgerCard } from './LedgerCard';
import { OngoingWorkOverview } from './WorkRail';

export function DispatchWorkPane() {
  return (
    <div className="overseer-root"
         style={{ ...overseerRootStyle, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* The pinned decision card sits above the work (pinned card spec 2026-10-08, Unit 7). */}
      <LedgerCard />
      <OngoingWorkOverview />
    </div>
  );
}
