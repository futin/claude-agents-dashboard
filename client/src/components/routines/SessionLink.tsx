import { useState } from 'react';

import type { RoutineCtl } from './ctl';

/** `session →` for a claude step. A transcript gone from disk answers in place, where the click was, instead of doing nothing. */
export default function SessionLink({ id, ctl }: { id: string; ctl: RoutineCtl }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed) return <span className="rtn-muted" role="status">{failed}</span>;
  return <button type="button" className="git-link" onClick={() => { void ctl.openSession(id).then(setFailed); }}>session →</button>;
}
