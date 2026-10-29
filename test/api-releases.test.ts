/**
 * `GET /api/releases` through the real route table (docs/subsystems/releases.md): the empty shape for anything that is not a tagged checkout, the parsed
 * tag-message contract, and the memo — it must notice a new commit, a tag cut with HEAD unchanged, a tag cut from another worktree and a delete after
 * `git pack-refs`, and must not re-read when nothing moved.
 *
 * Tags are written the way the release workflow writes them: `git tag -a … -F <file> --cleanup=verbatim`. The repo root is reached only through
 * `overrideReleasesRoot`, and every case restores it.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { GitFixture, withGitFixture } from './git-fixture.js';
import { overrideReleasesRoot, releasesReadCount } from '../server/lib/releases.js';
import type { ReleasesResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const EMPTY: ReleasesResponse = { current: null, releases: [] };
const BASELINE = 'Baseline — versioning starts here';

async function get(h: Harness): Promise<ReleasesResponse> {
  const r = await h.req('/api/releases');
  assert.equal(r.status, 200);
  return r.json as unknown as ReleasesResponse;
}

/** An annotated tag on `rev`, its message read from a file so headings and `#` lines survive. */
function tag(fx: GitFixture, dir: string, name: string, message: string, rev = 'HEAD'): void {
  const file = path.join(fx.root, `${name}.msg`);
  fs.writeFileSync(file, message);
  fx.git(dir, ['tag', '-a', name, rev, '-F', file, '--cleanup=verbatim']);
}

/** A repo at `rel` with one commit and the baseline tag on it. */
function baselineRepo(fx: GitFixture, rel = 'app'): string {
  const dir = fx.init(rel);
  fx.commit(dir, 'root');
  tag(fx, dir, 'v0.1.0', BASELINE);
  return dir;
}

const FIX_011 = 'fix: keep the open window (#3)\n\nRelease-Type: fix\nRelease-PR: 3\n';

/** Each case gets a fixture and a server; `point` aims the releases root at a fixture dir, and the root is restored after. */
async function withReleases(fn: (h: Harness, fx: GitFixture, point: (dir: string) => void) => Promise<void>): Promise<void> {
  await withGitFixture(fx =>
    withServer(ENV, async h => {
      try {
        await fn(h, fx, dir => overrideReleasesRoot(dir));
      } finally {
        overrideReleasesRoot(null);
      }
    }));
}

export async function run(): Promise<number> {
  console.log('\n=== releases endpoint (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('a folder that is not a checkout answers the empty shape', async () => {
    await withReleases(async (h, fx, point) => {
      point(fx.plain('not-git'));
      assert.deepStrictEqual(await get(h), EMPTY);
    });
  }));

  check(await testAsync('a checkout with no tags answers the empty shape', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = fx.init('app');
      fx.commit(dir, 'root');
      point(dir);
      assert.deepStrictEqual(await get(h), EMPTY);
    });
  }));

  check(await testAsync('the baseline tag alone is one baseline entry, and HEAD on it is ahead 0', async () => {
    await withReleases(async (h, fx, point) => {
      point(baselineRepo(fx));
      const body = await get(h);
      assert.deepStrictEqual(body.current, { version: '0.1.0', ahead: 0 });
      assert.equal(body.releases.length, 1);
      const { date, ...rest } = body.releases[0];
      assert.ok(!Number.isNaN(Date.parse(date)), `date ${date} parses`);
      assert.deepStrictEqual(rest, { version: '0.1.0', title: BASELINE, type: 'baseline', breaking: false, notes: '', items: [] });
    });
  }));

  check(await testAsync('a release tag parses to the contract, newest first, with the PR url from a GitHub origin', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = baselineRepo(fx);
      fx.git(dir, ['remote', 'add', 'origin', 'https://github.com/futin/claude-agents-dashboard.git']);
      fx.commit(dir, 'chip');
      tag(fx, dir, 'v0.2.0', [
        "feat(releases): version chip and What's new panel (#216)",
        '',
        '- The rail shows the version.',
        '- Every release, newest first.',
        '',
        'Release-Type: feat',
        'Release-Scope: releases',
        'Release-PR: 216',
        '',
      ].join('\n'));
      point(dir);
      const body = await get(h);
      assert.deepStrictEqual(body.current, { version: '0.2.0', ahead: 0 });
      assert.deepStrictEqual(body.releases.map(r => r.type), ['feat', 'baseline']);
      const { date, ...rest } = body.releases[0];
      assert.ok(!Number.isNaN(Date.parse(date)), `date ${date} parses`);
      assert.deepStrictEqual(rest, {
        version: '0.2.0',
        title: "feat(releases): version chip and What's new panel",
        type: 'feat',
        scope: 'releases',
        pr: 216,
        breaking: false,
        notes: '- The rail shows the version.\n- Every release, newest first.',
        url: 'https://github.com/futin/claude-agents-dashboard/pull/216',
        items: [{
          pr: 216,
          type: 'feat',
          scope: 'releases',
          breaking: false,
          title: "feat(releases): version chip and What's new panel",
          notes: '- The rail shows the version.\n- Every release, newest first.',
          url: 'https://github.com/futin/claude-agents-dashboard/pull/216',
        }],
      });
    });
  }));

  check(await testAsync('a commit after the first read moves ahead from 0 to 1', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = baselineRepo(fx);
      point(dir);
      assert.equal((await get(h)).current?.ahead, 0);
      fx.commit(dir, 'next');
      assert.equal((await get(h)).current?.ahead, 1);
      assert.equal(releasesReadCount(), 2);
    });
  }));

  check(await testAsync('a tag cut with HEAD unchanged shows up on the next read', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = baselineRepo(fx);
      fx.commit(dir, 'next');
      point(dir);
      assert.equal((await get(h)).releases.length, 1);
      tag(fx, dir, 'v0.1.1', FIX_011);
      const body = await get(h);
      assert.equal(body.releases.length, 2);
      assert.deepStrictEqual(body.current, { version: '0.1.1', ahead: 0 });
    });
  }));

  check(await testAsync('a server rooted in a linked worktree sees a tag cut from the main checkout', async () => {
    await withReleases(async (h, fx, point) => {
      const main = baselineRepo(fx);
      const wt = fx.p('wt');
      fx.git(main, ['worktree', 'add', '-q', '-b', 'side', wt]);
      point(wt);
      assert.equal((await get(h)).releases.length, 1);
      fx.commit(main, 'feature');
      tag(fx, main, 'v0.2.0', 'feat: something (#4)\n\nRelease-Type: feat\nRelease-PR: 4\n');
      assert.deepStrictEqual((await get(h)).releases.map(r => r.version), ['0.2.0', '0.1.0']);
    });
  }));

  check(await testAsync('after git pack-refs the tags stay listed, and a deleted one goes', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = baselineRepo(fx);
      fx.commit(dir, 'next');
      tag(fx, dir, 'v0.1.1', FIX_011);
      point(dir);
      assert.equal((await get(h)).releases.length, 2);
      fx.git(dir, ['pack-refs', '--all']);
      assert.equal((await get(h)).releases.length, 2);
      fx.git(dir, ['tag', '-d', 'v0.1.1']);
      const body = await get(h);
      assert.deepStrictEqual(body.releases.map(r => r.version), ['0.1.0']);
      assert.equal(body.current?.version, '0.1.0');
    });
  }));

  check(await testAsync('two reads with nothing changed read the tags once', async () => {
    await withReleases(async (h, fx, point) => {
      point(baselineRepo(fx));
      const a = await get(h);
      const b = await get(h);
      assert.deepStrictEqual(b, a);
      assert.equal(releasesReadCount(), 1);
    });
  }));

  check(await testAsync('two concurrent requests on a fresh memo share one read', async () => {
    await withReleases(async (h, fx, point) => {
      point(baselineRepo(fx));
      const [a, b] = await Promise.all([get(h), get(h)]);
      assert.deepStrictEqual(b, a);
      assert.equal(a.releases.length, 1);
      assert.equal(releasesReadCount(), 1);
    });
  }));

  check(await testAsync('lightweight v9.9.9 and v1 tags are not releases and not the current version', async () => {
    await withReleases(async (h, fx, point) => {
      const dir = baselineRepo(fx);
      fx.commit(dir, 'next');
      fx.git(dir, ['tag', 'v9.9.9']);
      fx.git(dir, ['tag', 'v1']);
      point(dir);
      const body = await get(h);
      assert.deepStrictEqual(body.current, { version: '0.1.0', ahead: 1 });
      assert.deepStrictEqual(body.releases.map(r => r.version), ['0.1.0']);
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
