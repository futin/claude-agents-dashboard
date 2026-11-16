import { useState } from 'react';

import type { RoutineCtl } from './ctl';

/** `session →` for a claude step. A transcript gone from disk answers beside the button, where the click was, instead of doing nothing. */
export default function SessionLink({ id, ctl }: { id: string; ctl: RoutineCtl }) {
  const [failed, setFailed] = useState<string | null>(null);
  // The button stays: a failure may be transient, and a retry is one more click. The text sits beside it, where the click was.
  return (
    <>
      <button type="button" className="git-link" onClick={() => { setFailed(null); void ctl.openSession(id).then(setFailed); }}>session →</button>
      {failed && <> <span className="rtn-muted" role="status">{failed}</span></>}
    </>
  );
}
