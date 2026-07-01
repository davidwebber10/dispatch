import { overseerRootStyle } from '../atoms';
import { OngoingWorkOverview } from './WorkRail';

export function DispatchWorkPane() {
  return (
    <div className="overseer-root"
         style={{ ...overseerRootStyle, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <OngoingWorkOverview />
    </div>
  );
}
