import { ReleasesDrawer as KitReleasesDrawer, type ReleasesResponse } from 'ui-kit';

import { useBackClose } from '../hooks/useBackClose';
import { useNarrow } from '../hooks/useNarrow';
import { Markdown } from './Markdown';

/**
 * The What's new drawer (docs/subsystems/releases.md): ui-kit's, plus the two things this app adds to it. Below `md` (768px) it is full screen with no
 * scrim to tap, so the phone's back gesture is the other exit, as for the chat drawer; and the notes go through the app's own `Markdown`. Rendered by
 * `AppShell`, not inside the rail, because `.nav.hid` hides the rail with a `transform`, and a transformed ancestor would turn this `position:fixed`
 * panel into one positioned inside the rail. Escape, the ✕ and a scrim click are ui-kit's.
 */
export function ReleasesDrawer({ data, onClose }: { data: ReleasesResponse; onClose: () => void }) {
  useBackClose(onClose);
  return <KitReleasesDrawer data={data} onClose={onClose} narrow={useNarrow()} renderNotes={t => <Markdown text={t} />} />;
}
