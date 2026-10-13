/**
 * The compare URL behind a branch's Open PR link. Built from `RepoGitStats.originUrl` alone, so it needs no API and no token. Only github.com and
 * gitlab.com are known: any other host, or a path of the wrong shape, gives null instead of a guessed link.
 */

/** Host and path of a remote URL; null when it parses as neither a URL nor `[user@]host:path`. */
function hostAndPath(originUrl: string): { host: string; path: string } | null {
  if (originUrl.includes('://')) {
    let u: URL;
    try { u = new URL(originUrl); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') return null;
    return { host: u.hostname, path: u.pathname };
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(originUrl);
  return scp ? { host: scp[1], path: scp[2] } : null;
}

const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/');

export function gitCompareUrl(originUrl: string | null, trunk: string | null, branch: string): string | null {
  if (originUrl === null || trunk === null || branch === trunk) return null;
  const parts = hostAndPath(originUrl);
  if (!parts) return null;
  const path = parts.path.replace(/\/$/, '').replace(/\.git$/, '').replace(/^\//, '');
  const segments = path.split('/');
  if (segments.some(s => s === '')) return null;
  const host = parts.host.toLowerCase();
  const range = `${enc(trunk)}...${enc(branch)}?expand=1`;
  if (host === 'github.com' && segments.length === 2) return `https://github.com/${path}/compare/${range}`;
  if (host === 'gitlab.com' && segments.length >= 2) return `https://gitlab.com/${path}/-/compare/${range}`;
  return null;
}
