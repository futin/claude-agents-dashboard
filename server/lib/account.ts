/**
 * account.ts — who the CLI is signed in as.
 *
 * Claude Code caches the OAuth profile it fetched at login in
 * `~/.claude.json` under `oauthAccount`: name, email, organisation, seat and
 * rate-limit tiers, and whether extra usage is enabled. That record is the
 * ONLY place the account has a name — `lib/usage.ts` talks to the usage
 * endpoint, which answers with percentages and reset times and nothing about
 * the person.
 *
 * Read-only and fail-open, like every auxiliary reader here: a missing file, a
 * truncated write, a record without the key — all of them yield `null`, and the
 * header draws its usage half alone rather than breaking.
 *
 * Zero runtime deps (Node built-ins only).
 *
 * The file is small (tens of KB) but it is re-read on a poll, so the parse is
 * cached against the file's mtime + size: a login, a logout or any other write
 * changes both and invalidates it on the next call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountProfile } from '../../shared/types.js';

/** `homeDir` is injectable so a test can point this at a fixture home. */
function accountFile(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude.json');
}

/**
 * The plan labels worth printing, keyed by `userRateLimitTier`. A table and not
 * a prettifier: the raw values are internal codenames
 * (`default_raven`, `default_claude_max_5x`), and mechanically title-casing one
 * would put Anthropic's internal names on the user's screen. An unknown tier
 * gets no label at all, which the header renders as no pill — the honest
 * outcome, and the one that cannot be wrong.
 */
const PLAN_LABELS: Record<string, string> = {
  default_claude_free: 'Free',
  default_claude_pro: 'Pro',
  default_claude_max_5x: 'Max 5×',
  default_claude_max_20x: 'Max 20×'
};

/** `default_claude_max_5x` → `Max 5×`; anything unrecognised → `''`. */
export function planLabel(tier: unknown): string {
  return typeof tier === 'string' ? PLAN_LABELS[tier] ?? '' : '';
}

/**
 * `team_tier_1` → `Team tier 1`. Prettified rather than tabled, unlike the plan
 * above: seat tiers are descriptive words already (`team`, `enterprise`), so
 * spacing them is a faithful reading, not a guess at a marketing name.
 * Sentence case, so it sits beside the org name as a label rather than shouting.
 */
export function seatLabel(tier: unknown): string {
  if (typeof tier !== 'string') return '';
  const words = tier.split('_').filter(Boolean);
  if (!words.length) return '';
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

/**
 * Shape one `oauthAccount` record. Pure — no disk, no clock — so the mapping is
 * testable without a fixture home.
 *
 * A record with neither a name nor an email identifies nobody, so it is `null`
 * rather than a profile of blanks: `usageStatus: 'signed-out'` is precisely the
 * state where the credential is present and empty, and the header has a chip of
 * its own for that. Two drawings of "signed out" is one too many.
 */
export function shapeProfile(raw: unknown): AccountProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const name = str(a.fullName) || str(a.displayName);
  const email = str(a.emailAddress);
  if (!name && !email) return null;
  return {
    name,
    email,
    organization: str(a.organizationName),
    plan: planLabel(a.userRateLimitTier),
    seat: seatLabel(a.seatTier),
    extraUsage: a.hasExtraUsageEnabled === true
  };
}

/** mtime+size of the last parse, so a poll re-reads only after a write. */
let cache: { key: string; profile: AccountProfile | null } | null = null;

/** Drop the memo. Tests call this between fixture homes; nothing else needs it. */
export function clearAccountCache(): void {
  cache = null;
}

/**
 * The signed-in profile, or `null` when there isn't one to read. Never throws.
 */
export function readAccountProfile(homeDir?: string): AccountProfile | null {
  const file = accountFile(homeDir);
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    // No file at all — and no memo to keep, or a later login would be invisible.
    cache = null;
    return null;
  }
  if (cache && cache.key === key) return cache.profile;
  let profile: AccountProfile | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { oauthAccount?: unknown };
    profile = shapeProfile(parsed.oauthAccount);
  } catch {
    // Unreadable or mid-write. Memoised as `null` against this exact mtime+size,
    // so a torn read is not retried every 30s until the file changes again.
    profile = null;
  }
  cache = { key, profile };
  return profile;
}
