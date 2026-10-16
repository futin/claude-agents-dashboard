import type { ConnectionOrigin, WriteAccess } from '../../../shared/types';

const HOW: Record<ConnectionOrigin, string> = {
  local: 'from this machine',
  tailnet: 'via tailnet',
  lan: 'via LAN',
  unknown: 'from an unrecognised address',
};

const ACCESS: Record<WriteAccess, string> = {
  open: 'writes need no token',
  token: 'writes need the answer token',
  none: 'read-only: no answer token is set',
};

/**
 * Settings › Local › Connection's line about this browser, off `GET /api/health`: `This device reaches the dashboard <how><switch note> — <access>.` Null
 * before health answers or from an older server without `writeAccess`. The switch note names tailnet trust only when it is known to be off.
 */
export function writeStatusLine(
  origin: ConnectionOrigin | undefined, writeAccess: WriteAccess | undefined, trustTailnet: boolean | undefined
): string | null {
  if (origin === undefined || writeAccess === undefined) return null;
  const note = origin === 'tailnet' && trustTailnet === false ? ', and tailnet trust is off' : '';
  return `This device reaches the dashboard ${HOW[origin]}${note} — ${ACCESS[writeAccess]}.`;
}
