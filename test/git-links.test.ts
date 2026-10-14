/**
 * `client/src/lib/gitLinks.ts`: the compare URL behind a branch's Open PR link. Pure, so no React and no DOM. Only github.com and gitlab.com are known hosts;
 * any other origin yields no link rather than a guessed one.
 */
import assert from 'node:assert';

import { gitCompareUrl } from '../client/src/lib/gitLinks.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const GH = 'https://github.com/acme/app/compare/main...feat/x?expand=1';
const GL = (path: string) => `https://gitlab.com/${path}/-/compare/main...feat/x?expand=1`;

export function run(): number {
  console.log('\n=== git-links: compare URL ===\n');
  let p = 0, f = 0;

  const githubForms = [
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'http://github.com/acme/app.git',
    'ssh://github.com/acme/app.git',
    'ssh://github.com:22/acme/app.git',
    'github.com:acme/app.git',
    'git@github.com:acme/app.git',
    'https://GitHub.com/acme/app.git',
  ];
  for (const origin of githubForms) {
    if (test(`github: ${origin}`, () => assert.strictEqual(gitCompareUrl(origin, 'main', 'feat/x'), GH))) p++; else f++;
  }

  if (test('gitlab: nested group keeps every segment', () => {
    assert.strictEqual(gitCompareUrl('https://gitlab.com/grp/sub/app.git', 'main', 'feat/x'), GL('grp/sub/app'));
  })) p++; else f++;

  if (test('gitlab: scp-like', () => {
    assert.strictEqual(gitCompareUrl('gitlab.com:grp/app.git', 'main', 'feat/x'), GL('grp/app'));
  })) p++; else f++;

  if (test('branch is percent-encoded per segment, slashes kept', () => {
    assert.strictEqual(gitCompareUrl('https://github.com/acme/app.git', 'main', 'fix/a b#c'), 'https://github.com/acme/app/compare/main...fix/a%20b%23c?expand=1');
  })) p++; else f++;

  const none: [string, string | null, string | null, string][] = [
    ['github needs exactly two segments', 'https://github.com/acme/sub/app.git', 'main', 'feat/x'],
    ['bitbucket is unknown', 'https://bitbucket.org/acme/app.git', 'main', 'feat/x'],
    ['a github look-alike host is unknown', 'https://github.example.com/acme/app.git', 'main', 'feat/x'],
    ['a local path has no link', '/tmp/origin.git', 'main', 'feat/x'],
    ['no origin', null, 'main', 'feat/x'],
    ['no trunk', 'https://github.com/acme/app.git', null, 'feat/x'],
    ['the trunk itself', 'https://github.com/acme/app.git', 'main', 'main'],
    ['a double slash in the path', 'https://github.com/acme//app.git', 'main', 'feat/x'],
    ['an unparseable URL', 'https://[bad', 'main', 'feat/x'],
  ];
  for (const [name, origin, trunk, branch] of none) {
    if (test(`null: ${name}`, () => assert.strictEqual(gitCompareUrl(origin, trunk, branch), null))) p++; else f++;
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
