/**
 * Guards the chat drawer's keep-open rule (#434): while any composer it renders holds unsent text, Escape, the scrim and Back leave the drawer open, and
 * only ✕ closes it — the rule the job drawer already follows (#376, `docs/subsystems/chat.md` §Four ways out).
 *
 * Source assertions, because this suite has no DOM: the defect is a stray exit that skips the check, and each exit is one line of source.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Nearest ancestor of `from` that holds a `package.json`. */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const read = (name: string) => fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', name), 'utf8');

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };
  const drawer = read('ChatDrawer.tsx');

  t('ChatDrawer: Escape, the scrim and Back each read keepOpen, and a refused Back re-arms', () => {
    assert.match(drawer, /e\.key === 'Escape' && !keepOpen\.current\) onClose\(\)/);
    assert.match(drawer, /className="chat-back" onClick=\{\(\) => \{ if \(!keepOpen\.current\) onClose\(\); \}\}/);
    assert.match(drawer, /useBackClose\(\(\) => \{ if \(keepOpen\.current\) setBackGen\(g => g \+ 1\); else onClose\(\); \}, backGen\)/);
    assert.ok(!/useBackClose\(onClose\)/.test(drawer), 'Back closes unconditionally');
  });

  t('ChatDrawer: ✕ still closes unconditionally', () => {
    assert.match(drawer, /<button className="chat-x" onClick=\{onClose\} aria-label="Close">/);
  });

  t('ChatDrawer: keepOpen is the OR of one draft flag per composer, each wired to its panel', () => {
    assert.match(drawer, /const drafts = useRef\(\{ resume: false, message: false, plan: false, question: false \}\);/);
    assert.match(drawer, /keepOpen\.current = drafts\.current\.resume \|\| drafts\.current\.message \|\| drafts\.current\.plan \|\| drafts\.current\.question;/);
    assert.match(drawer, /<QuestionPanel state=\{question\} onDraft=\{onDraft\.question\} \/>/);
    assert.match(drawer, /<PlanPanel state=\{plan\} onDraft=\{onDraft\.plan\} \/>/);
    assert.match(drawer, /<MessagePanel state=\{message\} suggestion=\{suggestion\} onDraft=\{onDraft\.message\} \/>/);
    assert.match(drawer, /<ResumePanel session=\{session\} suggestion=\{suggestion\} onDraft=\{onDraft\.resume\} \/>/);
  });

  t('ResumePanel reports a trimmed non-empty draft, and false on unmount', () => {
    const src = read('ResumePanel.tsx');
    assert.match(src, /const draft = text\.trim\(\) !== '';/);
    assert.match(src, /useEffect\(\(\) => \{ onDraft\?\.\(draft\); return \(\) => onDraft\?\.\(false\); \}, \[draft, onDraft\]\);/);
  });

  // MessagePanel and PlanPanel stay mounted after a send, a dismiss or an expiry (they render a note, or nothing), so the text they still hold must stop
  // counting the moment no composer shows it.
  t('MessagePanel reports a draft only while its composer shows, and false on unmount', () => {
    const src = read('MessagePanel.tsx');
    assert.match(src, /const draft = !!pending && phase !== 'gone' && phase !== 'sent' && text\.trim\(\) !== '';/);
    assert.match(src, /useEffect\(\(\) => \{ onDraft\?\.\(draft\); return \(\) => onDraft\?\.\(false\); \}, \[draft, onDraft\]\);/);
  });

  t('PlanPanel reports a feedback draft only while its composer shows, and false on unmount', () => {
    const src = read('PlanPanel.tsx');
    assert.match(src, /const draft = !!pending && phase !== 'gone' && phase !== 'sent' && feedback\.trim\(\) !== '';/);
    assert.match(src, /useEffect\(\(\) => \{ onDraft\?\.\(draft\); return \(\) => onDraft\?\.\(false\); \}, \[draft, onDraft\]\);/);
  });

  // QuestionPanel renders a note or nothing once answered or gone, and returns early before its composer — so the report sits above those returns.
  t('QuestionPanel reports its typed Other text through questionDraftHeld, above its early returns, and false on unmount', () => {
    const src = read('QuestionPanel.tsx');
    const effect = /useEffect\(\(\) => \{ onDraft\?\.\(held\); return \(\) => onDraft\?\.\(false\); \}, \[held, onDraft\]\);/;
    assert.match(src, /const held = questionDraftHeld\(pending, phase, draft\);/);
    assert.match(src, effect);
    assert.ok(src.search(effect) < src.indexOf("if (phase === 'gone')"), 'the onDraft effect must run before the early returns');
  });

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
