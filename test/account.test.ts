/**
 * `server/lib/account.ts` — the signed-in profile behind the header chip.
 *
 * Two layers, split the way `api-usage-rates.test.ts` splits its own: the
 * mapping rules go against the pure `shapeProfile`/`planLabel`/`seatLabel`, and
 * the disk behaviour (missing, torn, re-read after a write) goes against
 * `readAccountProfile` over a tmpdir home. Nothing here touches the developer's
 * real `~/.claude.json`, which would otherwise decide a case by whose machine
 * ran it.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearAccountCache, planLabel, readAccountProfile, seatLabel, shapeProfile
} from '../server/lib/account.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** The real record's shape, field for field. */
const RECORD = {
  accountUuid: 'd9081eff-ae22-4549-8092-ccd6e8ed31a0',
  emailAddress: 'someone@example.com',
  hasExtraUsageEnabled: true,
  seatTier: 'team_tier_1',
  displayName: 'Sam',
  fullName: 'Sam Rivers',
  organizationName: 'Example Co',
  organizationType: 'claude_team',
  organizationRateLimitTier: 'default_raven',
  userRateLimitTier: 'default_claude_max_5x'
};

/** A throwaway home holding `.claude.json` with `body` as its whole content. */
function fixtureHome(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-'));
  fs.writeFileSync(path.join(dir, '.claude.json'), body);
  return dir;
}

export function run(): number {
  console.log('\n=== account profile ===\n');
  let p = 0, f = 0;

  if (test('plan labels cover the four subscription tiers', () => {
    assert.equal(planLabel('default_claude_free'), 'Free');
    assert.equal(planLabel('default_claude_pro'), 'Pro');
    assert.equal(planLabel('default_claude_max_5x'), 'Max 5×');
    assert.equal(planLabel('default_claude_max_20x'), 'Max 20×');
  })) p++; else f++;

  if (test('an unrecognised tier gets no plan label rather than a guess', () => {
    // The org-side codename, which must never reach a screen.
    assert.equal(planLabel('default_raven'), '');
    assert.equal(planLabel('default_claude_max_50x'), '');
    assert.equal(planLabel(''), '');
    assert.equal(planLabel(undefined), '');
    assert.equal(planLabel(7), '');
  })) p++; else f++;

  if (test('seat tiers are spaced into sentence case', () => {
    assert.equal(seatLabel('team_tier_1'), 'Team tier 1');
    assert.equal(seatLabel('enterprise'), 'Enterprise');
    assert.equal(seatLabel(''), '');
    assert.equal(seatLabel(null), '');
  })) p++; else f++;

  if (test('a full record maps field for field', () => {
    assert.deepEqual(shapeProfile(RECORD), {
      name: 'Sam Rivers',
      email: 'someone@example.com',
      organization: 'Example Co',
      plan: 'Max 5×',
      seat: 'Team tier 1',
      extraUsage: true
    });
  })) p++; else f++;

  if (test('the name falls back to displayName, and blanks stay blank', () => {
    const shaped = shapeProfile({ ...RECORD, fullName: '  ' });
    assert.equal(shaped?.name, 'Sam');
    const personal = shapeProfile({
      emailAddress: 'solo@example.com', fullName: 'Solo', seatTier: '', userRateLimitTier: 'x'
    });
    assert.deepEqual(personal, {
      name: 'Solo', email: 'solo@example.com', organization: '', plan: '', seat: '', extraUsage: false
    });
  })) p++; else f++;

  if (test('a record identifying nobody is null, not a profile of blanks', () => {
    // `usageStatus: 'signed-out'` already draws this state, and two drawings of
    // it is one too many — see HeaderAccount.
    assert.equal(shapeProfile({ seatTier: 'team_tier_1', hasExtraUsageEnabled: true }), null);
    assert.equal(shapeProfile({ fullName: '   ', emailAddress: '' }), null);
    assert.equal(shapeProfile(null), null);
    assert.equal(shapeProfile('nope'), null);
    assert.equal(shapeProfile(42), null);
  })) p++; else f++;

  if (test('extraUsage is true only for a literal true', () => {
    assert.equal(shapeProfile({ ...RECORD, hasExtraUsageEnabled: 'yes' })?.extraUsage, false);
    assert.equal(shapeProfile({ ...RECORD, hasExtraUsageEnabled: 1 })?.extraUsage, false);
    assert.equal(shapeProfile({ ...RECORD, hasExtraUsageEnabled: undefined })?.extraUsage, false);
  })) p++; else f++;

  if (test('reads oauthAccount out of a real-shaped file', () => {
    clearAccountCache();
    const home = fixtureHome(JSON.stringify({ numStartups: 4, oauthAccount: RECORD, projects: {} }));
    assert.equal(readAccountProfile(home)?.name, 'Sam Rivers');
    assert.equal(readAccountProfile(home)?.plan, 'Max 5×');
  })) p++; else f++;

  if (test('a missing file, a torn write and a file without the key all fail open', () => {
    clearAccountCache();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'account-'));
    assert.equal(readAccountProfile(gone), null, 'no ~/.claude.json at all');
    clearAccountCache();
    assert.equal(readAccountProfile(fixtureHome('{"oauthAccount":{"emailAdd')), null, 'torn write');
    clearAccountCache();
    assert.equal(readAccountProfile(fixtureHome('{"numStartups":4}')), null, 'no oauthAccount key');
    clearAccountCache();
    assert.equal(readAccountProfile(fixtureHome('[]')), null, 'not an object at the root');
  })) p++; else f++;

  if (test('a write invalidates the memo, so a login is visible on the next poll', () => {
    clearAccountCache();
    const home = fixtureHome(JSON.stringify({ projects: {} }));
    assert.equal(readAccountProfile(home), null, 'signed out to begin with');
    const file = path.join(home, '.claude.json');
    // Same call, new content: the memo is keyed on mtime+size, and both move.
    fs.writeFileSync(file, JSON.stringify({ projects: {}, oauthAccount: RECORD }));
    // mtime resolution can be coarse enough to collide inside one tick; the
    // size change alone still has to be enough, so assert with the clock left
    // deliberately untouched.
    assert.equal(readAccountProfile(home)?.name, 'Sam Rivers', 'the new profile must be read');
  })) p++; else f++;

  console.log(`\naccount profile: ${p} passed, ${f} failed`);
  return f;
}
