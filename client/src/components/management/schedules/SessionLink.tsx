import { useState } from 'react';

import type { ScheduleCtl } from './ctl';

/** `session →` for a claude step. A transcript gone from disk answers in place, where the click was, instead of doing nothing. */
export default function SessionLink({ id, ctl }: { id: string; ctl: ScheduleCtl }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed) return <span className="sch-muted" role="status">{failed}</span>;
  return <button type="button" className="git-link" onClick={() => { void ctl.openSession(id).then(setFailed); }}>session →</button>;
}
